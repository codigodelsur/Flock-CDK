import { SQSEvent, SQSHandler } from 'aws-lambda';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import OpenAI from 'openai';
import sharp from 'sharp';

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

      console.log('users', JSON.stringify(users));

      // TODO - Add support for multi-users
      if (users.length < 2) {
        continue;
      }

      const matchedBooks = users[0].books.filter((candidateBook: DbUserBook) =>
        users[1].books.find(
          (userBook: DbUserBook) => userBook.bookId === candidateBook.bookId
        )
      );

      const matchedGenres = users[0].favoriteGenres.filter(
        (candidateGenre: DbGenre) =>
          users[1].favoriteGenres.find(
            (userGenre: DbGenre) => userGenre.genreId === candidateGenre.genreId
          )
      );

      console.log('matchedBooks', matchedBooks);
      console.log('matchedGenres', matchedGenres);

      let recommendations: AIBook[] = [];

      const uniqueTitles = new Set<string>();

      for (const matchedBook of matchedBooks) {
        const dbBook = await getDBBook(db, matchedBook.bookId);
        const aiRecommendations = await getAIRecommendations(dbBook, 5);

        const filteredRecommendations = aiRecommendations.filter(
          (rec: { title: string; author: string }) =>
            !uniqueTitles.has(rec.title.toLowerCase()) // We filter books that are already on the list
        );

        filteredRecommendations.forEach(
          (rec: { title: string; author: string }) =>
            uniqueTitles.add(rec.title.toLowerCase())
        );

        recommendations = recommendations.concat(filteredRecommendations);
      }

      if (recommendations.length < 15) {
        for (const matchedGenre of matchedGenres) {
          const aiRecommendations = await getAIRecommendationsByGenre(
            matchedGenre,
            5
          );

          const filteredRecommendations = aiRecommendations.filter(
            (rec: { title: string; author: string }) =>
              !uniqueTitles.has(rec.title.toLowerCase()) // We filter books that are already on the list
          );

          filteredRecommendations.forEach(
            (rec: { title: string; author: string }) =>
              uniqueTitles.add(rec.title.toLowerCase())
          );

          recommendations = recommendations.concat(filteredRecommendations);
        }
      }

      if (recommendations.length < 15) {
        const aiRecommendations = await getAIRecommendationsByUsers(users, 10);

        const filteredRecommendations = aiRecommendations.filter(
          (rec: { title: string; author: string }) =>
            !uniqueTitles.has(rec.title.toLowerCase()) // We filter books that are already on the list
        );

        filteredRecommendations.forEach(
          (rec: { title: string; author: string }) =>
            uniqueTitles.add(rec.title.toLowerCase())
        );

        recommendations = recommendations.concat(filteredRecommendations);
      }

      for (const recommendation of recommendations.slice(0, 15)) {
        console.log('recommendation', recommendation);

        const isbnDbData = await getISBNDBBook(recommendation);

        console.log('isbnDbData', isbnDbData);

        if (!isbnDbData || !isbnDbData.subjects || !isbnDbData.cover) {
          continue;
        }

        const book: DbBook = {
          isbn: isbnDbData.isbn,
          cover: isbnDbData.cover,
          name: isbnDbData.name,
          author: isbnDbData.author,
          description: isbnDbData.description || '',
          subjects: isbnDbData.subjects,
          olid: null,
        };

        let olAuthor;

        try {
          const olResponse = await getOpenLibraryAuthorByBook(book);
          console.log('Open Library Author Data', olResponse);

          olAuthor = olResponse.author;
          book.olid = olResponse.olid;
        } catch (e) {
          console.error(e);
        }

        if (!olAuthor) {
          continue;
        }

        const authorId = await insertAuthor(
          db,
          recommendation.author,
          olAuthor!.olid!,
          isbnDbData.subjects
        );

        const newBookId = crypto.randomUUID();

        const coverResponse = await uploadCover({
          ...book,
          id: newBookId,
        });

        const recommendedBookId = await insertBook(
          db,
          book,
          authorId,
          newBookId,
          !!coverResponse
        );

        await insertBookRecommendation(
          db,
          data.conversationId,
          recommendedBookId
        );
      }
    }
  } catch (e) {
    console.error(e);
  } finally {
    await db.end();
    console.timeEnd('handler');
  }
};

async function getOpenLibraryAuthorByBook(book: DbBook) {
  const { authorOlid, workOlid } = await getOpenLibraryAuthorIdByISBN(
    book.isbn!
  );

  if (!authorOlid) {
    const author = await getOpenLibraryAuthorByName(book.author!);
    return {
      author,
      olid: workOlid,
    };
  }

  return {
    author: {
      olid: authorOlid,
    },
    olid: workOlid,
  };
}

async function getOpenLibraryAuthorByName(name: string) {
  const response = await fetch(
    `https://openlibrary.org/search/authors.json?q=${stringToUrl(name)}`
  );
  const result = await response.json();

  if (!result.docs || result.docs.length === 0) {
    return null;
  }

  return {
    olid: result.docs[0].key,
    name,
  };
}

async function getOpenLibraryAuthorIdByISBN(isbn: string) {
  const editionResponse = await fetch(
    `https://openlibrary.org/isbn/${isbn}.json`
  );

  if (editionResponse.status !== 200) {
    return { authorOlid: null, workOlid: null };
  }

  const edition = await editionResponse.json();

  if (!edition || !edition.authors) {
    return { authorOlid: null, workOlid: null };
  }

  const olid = edition.works[0].key.replaceAll('/works/', '');

  const workResponse = await fetch(
    `https://openlibrary.org/works/${olid}.json`
  );

  const work = await workResponse.json();

  let authorOlid;

  authorOlid =
    work.authors &&
    work.authors.length > 0 &&
    work.authors[0].author?.key?.replaceAll('/authors/', '');

  return {
    authorOlid,
    workOlid: olid,
  };
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
    `SELECT "genreId", g.name as "genreName" FROM "UserFavoriteGenres" ug INNER JOIN "Genres" g ON g.id = ug."genreId" WHERE ug."userId" = $1`,
    [userId]
  );

  return { id: userId, books, favoriteAuthors, favoriteGenres };
}

async function getDBBook(db: Client, bookId: string) {
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

async function insertBook(
  db: Client,
  book: DbBook,
  authorId: string,
  newBookId: string,
  goodCover: boolean
) {
  const {
    rows: [foundBook],
  } = await db.query(
    `
      SELECT b.id, b.olid FROM "Books" b
      WHERE b.olid = $1 or b.isbn = $2
    `,
    [book.olid, book.isbn]
  );

  if (foundBook) {
    await db.query(`UPDATE "Books" SET "goodCover" = $1 WHERE id = $2`, [
      goodCover,
      foundBook.id,
    ]);

    return foundBook.id;
  }

  console.log(`Inserting ${book.name} book...`);

  const {
    rows: [{ id }],
  } = await db.query(
    `
      INSERT INTO "Books" (id, name, description, subjects, "authorId", isbn, olid, source, priority, "goodCover", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id
    `,
    [
      newBookId,
      book.name,
      book.description,
      book.subjects,
      authorId,
      book.isbn,
      book.olid,
      'CHAT_GPT_RECOMMENDATION',
      0,
      goodCover,
      new Date(),
      new Date(),
    ]
  );

  return id;
}

async function insertBookRecommendation(
  db: Client,
  conversationId: string,
  bookId: string
) {
  const response = await db.query(
    `
      INSERT INTO "BookRecommendations" ("id", "conversationId", "bookId", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5)
    `,
    [crypto.randomUUID(), conversationId, bookId, new Date(), new Date()]
  );

  return response;
}

async function insertAuthor(
  db: Client,
  name: string,
  olid: string,
  subjects: string
) {
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

  console.log(`Inserting ${name} author...`);

  const {
    rows: [{ id }],
  } = await db.query(
    `
      INSERT INTO "Authors" ("id", "name", "bio", "olid", "subjects", "source", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `,
    [
      crypto.randomUUID(),
      name,
      '',
      olid,
      subjects,
      'FLOCK',
      new Date(),
      new Date(),
    ]
  );

  return id;
}

async function getAIRecommendations(book: DbBook, count: number) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: 'recommend popular books like New York Times best sellers',
      },
      {
        role: 'user',
        content: `recommend me ${count} similar books to "${book.name}" by "${book.author}"`,
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

async function getAIRecommendationsByGenre(genre: DbGenre, count: number) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: 'recommend popular books like New York Times best sellers',
      },
      {
        role: 'user',
        content: `recommend me ${count} popular and current books from subject "${genre.genreName}"`,
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

async function getAIRecommendationsByUsers(users: any[], count: number) {
  const userContent = `recommend me ${count} popular and current books to read between two people if one of them likes ${users[0].favoriteGenres
    .map((genre: DbGenre) => genre.genreName)
    .join(', ')} books and the other likes ${users[1].favoriteGenres
    .map((genre: DbGenre) => genre.genreName)
    .join(', ')} books`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: 'recommend popular books like New York Times best sellers',
      },
      {
        role: 'user',
        content: userContent,
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

async function getISBNDBBook(aiBook: AIBook): Promise<DbBook | null> {
  const url = `${process.env.ISBNDB_API_URL}/books/${stringToUrl(
    aiBook.author
  )} ${stringToUrl(aiBook.title)}`;

  const params = ['language=en', 'pageSize=5'];

  const response = await fetch(`${url}?${params.join('&')}`, {
    headers: { Authorization: process.env.ISBNDB_API_KEY! },
  });

  const result = await response.json();

  if (!result.books) {
    return null;
  }

  let book = null;

  for (const item of result.books) {
    if (
      item.isbn13 &&
      item.synopsis &&
      item.title &&
      item.subjects &&
      item.image &&
      item.authors &&
      !isBoxSet(item.title, item.edition) &&
      item.authors.length > 0
    ) {
      const subjects = removeDuplicates(
        removeDuplicates(
          item.subjects
            .map((category: string) => getSubjectsByCategory(category))
            .filter((category: string) => !!category)
        )
          .join(',')
          .split(',')
      ).join(',');

      console.log('subjects', JSON.stringify(item.subjects));

      book = {
        isbn: item.isbn13,
        cover: item.image,
        name: item.title,
        description: escapeText(item.synopsis),
        author: item.authors[0],
        subjects,
      };

      break;
    }
  }

  return book;
}

function getSubjectsByCategory(category: string) {
  const subjects = [];

  for (const subject in SUBJECTS) {
    for (const chunk of category.split(' -> ')) {
      if (SUBJECTS[subject].includes(chunk)) {
        subjects.push(subject);
      }
    }
  }

  return removeDuplicates(subjects).join(',');
}

async function uploadCover(book: DbBook) {
  const s3Client = new S3Client({});

  if (!book.cover) {
    return;
  }

  const coverResponse = await fetch(book.cover!);
  const file = await coverResponse.arrayBuffer();

  if (file.byteLength < 5_000) {
    return;
  }

  const resizedFile = await sharp(file).resize(400).toBuffer();

  const command = new PutObjectCommand({
    Body: resizedFile,
    Bucket: process.env.IMAGES_BUCKET,
    Key: `covers/${book.id}.jpg`,
  });

  return s3Client.send(command);
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

function removeDuplicates(array: string[]) {
  return Array.from(new Set(array));
}

function escapeText(string: string) {
  if (!string) {
    return '';
  }

  return string.replaceAll(/(<[^>]+>)*/g, '');
}

function isBoxSet(title: string, edition?: string | number) {
  const boxSetTerms = [
    'Trilogy',
    'Books Set',
    'Boxed Set',
    'Books Collection Set',
    'Box Set',
    'Special Collector',
    'Ebook Collection',
    'Collection:',
    'Collection - ',
    'CD Collection',
    'Study Guide',
  ];

  const isBoxSetEdition =
    edition && typeof edition === 'string' && edition.includes('Boxed Set');

  return boxSetTerms.some((term) => title.includes(term)) || isBoxSetEdition;
}

type DbBook = {
  id?: string;
  cover?: string;
  olid?: string | null;
  isbn?: string;
  name: string;
  description?: string;
  author?: string;
  subjects: string;
};

type DbUserBook = {
  bookId: string;
  category: string;
};

type DbGenre = {
  genreId: string;
  genreName: string;
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

const SUBJECTS = require('./subjects.json');
