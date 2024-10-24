import { SQSEvent, SQSHandler } from 'aws-lambda';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import OpenAI from 'openai';

const openai = new OpenAI({
  organization: process.env.OPEN_AI_ORGANIZATION,
  project: process.env.OPEN_AI_PROJECT,
  apiKey: process.env.OPEN_AI_API_KEY,
});

export const handler: SQSHandler = async (event: SQSEvent) => {
  console.time('handler');

  const db = new Client({
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    ssl: {
      ca: readFileSync(join(__dirname, './bundle.pem')).toString(),
      rejectUnauthorized: false,
    },
  });

  await db.connect();

  console.timeLog('handler', 'db connected');

  try {
    for (const item of event.Records) {
      const { body } = item;

      const data = JSON.parse(JSON.parse(body).Message);

      if (!data.users || data.users.length < 2) {
        continue;
      }

      const users = await Promise.all(
        data.users.map((userId: string) => getUser(db, userId))
      );

      console.log('users', users);

      const matchedBooks = users[0].books.filter((candidateBook: Book) =>
        users[1].books.find(
          (userBook: Book) => userBook.id === candidateBook.id
        )
      );

      console.log('matchedBooks', matchedBooks);

      let recommendations: BookRecommendation[] = [];

      for (const matchedBook of matchedBooks) {
        const book = await getBook(db, matchedBook.bookId);
        const aiRecommendations = await getAIRecommendations(book);
        recommendations = recommendations.concat(aiRecommendations);
      }

      for (const recommendation of recommendations) {
        console.log('recommendation', recommendation);

        const googleData = await getGoogleData(
          recommendation.title,
          recommendation.author
        );

        const olData = await getOpenLibraryData(recommendation);

        console.log('Open Library Data', olData);

        if (!olData) {
          continue;
        }

        const book: Book = {
          name: googleData.title,
          description: googleData.description || '',
          author: recommendation.author,
          olid: olData.olid,
        };

        const authorId = await insertAuthor(
          db,
          recommendation.author,
          olData.author.olid
        );

        await insertBook(db, book, authorId);

        // TODO - Upload Cover to S3
      }
    }
  } catch (e) {
    console.error(e);
  } finally {
    await db.end();
    console.timeEnd('handler');
  }
};

async function getOpenLibraryData(book: AIBook) {
  const params = [
    `title=${stringToUrl(book.title)}`,
    `author=${stringToUrl(book.author)}`,
    'sort=rating',
    'limit=1',
    'fields=title,key,author_key,subject_key',
  ];

  try {
    const url = `https://openlibrary.org/search.json?${params.join('&')}`;

    const response = await fetch(url);

    const result = await response.json();

    const [data] = result.docs.map((item: OpenLibraryBook) => ({
      olid: item.key.replace('/works/', ''),
      title: item.title,
      author: {
        olid: item.author_key[0],
        name: book.author,
      },
    }));

    return data;
  } catch (e) {
    console.error('Open Library Fetch', e);
  }

  return null;
}

async function getUser(db: Client, userId: string) {
  const { rows: books } = await db.query(
    `SELECT "bookId", category FROM "UserBooks" ub WHERE ub."userId" = $1`,
    [userId]
  );

  const { rows: favoriteAuthors } = await db.query(
    `SELECT "authorId" FROM "UserFavoriteAuthors" ua WHERE ua."userId" = $1`,
    [userId]
  );

  const { rows: favoriteGenres } = await db.query(
    `SELECT "genreId" FROM "UserFavoriteGenres" ug WHERE ug."userId" = $1`,
    [userId]
  );

  return { id: userId, books, favoriteAuthors, favoriteGenres };
}

async function getBook(db: Client, bookId: string) {
  const {
    rows: [book],
  } = await db.query(
    `
      SELECT b.id, b.name, a.name as author FROM "Books" b
      INNER JOIN "Authors" a ON a.id = b."authorId"
      WHERE b.id = $1
    `,
    [bookId]
  );

  return book;
}

async function insertBook(db: Client, book: Book, authorId: string) {
  const {
    rows: [foundBook],
  } = await db.query(
    `
      SELECT b.id, b.olid FROM "Books" b
      WHERE b.olid = $1
    `,
    [book.olid]
  );

  if (foundBook) {
    return foundBook;
  }

  const response = await db.query(
    `
      INSERT INTO "Books" ("id", "name", "description", "authorId", "olid", "source", "priority", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    [
      crypto.randomUUID(),
      book.name,
      book.description,
      authorId,
      book.olid,
      'CHAT_GPT_RECOMMENDATION',
      0,
      new Date(),
      new Date(),
    ]
  );

  return response;
}

async function insertAuthor(db: Client, name: string, olid: string) {
  const {
    rows: [author],
  } = await db.query(
    `
      SELECT a.id, a.olid, a.name FROM "Authors" a
      WHERE a.olid = $1
    `,
    [olid]
  );

  if (author) {
    return author.id;
  }

  const {
    rows: [{ id }],
  } = await db.query(
    `
      INSERT INTO "Authors" ("id", "name", "bio", "olid", "source", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `,
    [crypto.randomUUID(), name, '', olid, 'FLOCK', new Date(), new Date()]
  );

  return id;
}

async function getAIRecommendations(book: Book) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: 'recommend popular books like New York Times best sellers',
      },
      {
        role: 'user',
        content: `recommend me 5 similar books to "${book.name}" by "${book.author}"`,
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'books',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            books: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  author: {
                    type: 'string',
                  },
                  title: { type: 'string' },
                },
                required: ['author', 'title'],
                additionalProperties: false,
              },
            },
          },
          required: ['books'],
          additionalProperties: false,
        },
      },
    },
  });

  const [firstChoice] = response.choices;

  return JSON.parse(firstChoice.message.content!).books;
}

async function getGoogleData(title: string, author: string) {
  const params = [
    `q=intitle:${stringToUrl(title)}+inauthor:${stringToUrl(author)}`,
    'projection=full',
    'langRestrict=en',
  ];

  const url = `https://www.googleapis.com/books/v1/volumes?${params.join('&')}`;

  const response = await fetch(url);
  const result = await response.json();

  if (
    !result.items ||
    result.items.length === 0 ||
    !result.items[0].volumeInfo?.categories ||
    result.items[0].volumeInfo?.categories.length === 0
  ) {
    return { categories: [], cover: null, title: null, description: null };
  }

  return getVolumeData(
    result.items[0].id,
    result.items[0].volumeInfo.description!
  );
}

async function getVolumeData(volumeId: string, description: string) {
  const url = `https://www.googleapis.com/books/v1/volumes/${volumeId}`;

  const response = await fetch(url);
  const result = await response.json();

  if (!result.volumeInfo) {
    return {
      categories: [],
      title: '',
      cover: '',
      description: '',
    };
  }

  return {
    categories: result.volumeInfo.categories || [],
    title: result.volumeInfo.title,
    cover: result.volumeInfo.imageLinks?.thumbnail,
    description,
  };
}

function stringToUrl(string: string) {
  return string
    .toLowerCase()
    .replaceAll(' ', '+')
    .replaceAll('(', '')
    .replaceAll(')', '')
    .replaceAll('#', '')
    .replaceAll('-', '')
    .replaceAll("'", '');
}

type Book = {
  id?: string;
  olid?: string;
  name: string;
  description?: string;
  author: string;
};

type BookRecommendation = {
  author: string;
  title: string;
};

type Author = {
  id?: string;
  olid?: string;
  name?: string;
};

type AIBook = {
  title: string;
  author: string;
};

type OpenLibraryBook = {
  key: string;
  author_key: string[];
  title: string;
  subject_key: string[];
};
