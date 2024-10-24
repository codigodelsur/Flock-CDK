import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ScheduledEvent, ScheduledHandler } from 'aws-lambda';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

export const handler: ScheduledHandler = async (event: ScheduledEvent) => {
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

  console.log('event', event);

  console.timeLog('handler', 'db connected');

  const nyTimesBooks = await getNewYorkTimesBooks();

  console.log('nyTimesBooks', nyTimesBooks);

  const books = await Promise.all(
    nyTimesBooks.map(async (book: NYTimesBook) => {
      const olResponse = await getOpenLibraryData(book);

      if (!olResponse) {
        return null;
      }

      const { olid, author } = olResponse;

      const dbBook = await getBookByOlid(db, olid);

      if (dbBook) {
        return null;
      }

      const { categories, title, description } = await getGoogleData(book);

      const subjects = removeDuplicates(
        categories
          .map((category: string) => getSubjectByText(category))
          .filter((category: string) => !!category)
      ).join(',');

      return {
        ...book,
        olid,
        title: title ? title : olResponse.title,
        author: { ...author, subjects },
        categories,
        subjects,
        description: description ? description : book.description,
      };
    })
  );

  console.log('books', books);

  try {
    for (const book of books) {
      if (!book) {
        continue;
      }

      const author = await insertAuthor(db, book.author);
      const newBook = await insertBook(db, { ...book, author });

      if (newBook.cover) {
        console.log(`Uploading covers/${newBook.id}.jpg`);
        await uploadCover(newBook);
      }
    }
  } catch (e) {
    console.error(e);
  } finally {
    await db.end();
    console.timeEnd('handler');
  }
};

async function uploadCover(book: Book) {
  const s3Client = new S3Client({});

  const coverResponse = await fetch(book.cover!);
  const file = await coverResponse.arrayBuffer();

  const command = new PutObjectCommand({
    Body: Buffer.from(file),
    Bucket: process.env.IMAGES_BUCKET,
    Key: `covers/${book.id}.jpg`,
  });

  return s3Client.send(command);
}

async function getNewYorkTimesBooks() {
  const response = await fetch(
    `${process.env.NY_TIMES_API_URL}/lists/full-overview.json?api-key=${process.env.NY_TIMES_API_KEY}`
  );

  const books = await response.json();

  return books.results.lists
    .flatMap((list: BooksList) => list.books)
    .map((book: NYTimesBook) => ({
      title: book.title,
      author: book.author,
      description: book.description,
      cover: book.book_image,
    }));
}

async function getOpenLibraryData(book: NYTimesBook) {
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

async function getGoogleData(book: NYTimesBook) {
  const params = [
    `q=intitle:${stringToUrl(book.title)}+inauthor:${stringToUrl(book.author)}`,
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

async function insertAuthor(db: Client, author: Author) {
  const { rows: authors } = await db.query(
    `SELECT id, olid, name FROM "Authors" a WHERE a."olid" = $1`,
    [author.olid]
  );

  if (authors.length === 0) {
    const id = crypto.randomUUID();

    console.log(`Inserting author ${JSON.stringify(author)}`);

    await db.query(
      `
      INSERT INTO "Authors"
        (id, olid, name, subjects, bio, source, "createdAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        author.olid,
        author.name,
        author.subjects,
        '',
        'NY_TIMES',
        new Date(),
        new Date(),
      ]
    );

    return { ...author, id };
  }

  return authors[0];
}

async function insertBook(db: Client, book: Book) {
  const { rows: books } = await db.query(
    `SELECT id, olid FROM "Books" b WHERE b."olid" = $1`,
    [book.olid]
  );

  if (books.length > 0) {
    return books[0];
  }

  const id = crypto.randomUUID();

  console.log(
    `Inserting book ${JSON.stringify({ ...book, id, description: '' })}`
  );

  await db.query(
    `
    INSERT INTO "Books"
      (id, name, description, subjects, source, "authorId", priority, olid, "createdAt", "updatedAt") 
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `,
    [
      id,
      book.title,
      book.description,
      book.subjects,
      'NY_TIMES',
      book.author?.id,
      PRIORITY_NY_TIMES,
      book.olid,
      new Date(),
      new Date(),
    ]
  );

  return { ...book, id };
}

async function getBookByOlid(db: Client, olid: string) {
  const { rows: books } = await db.query(
    `SELECT id, olid FROM "Books" b WHERE b."olid" = $1`,
    [olid]
  );

  if (books.length > 0) {
    return books[0];
  } else {
    return null;
  }
}

function getSubjectByText(text: string) {
  for (const subject in SUBJECTS) {
    for (const chunk of text.split(' / ')) {
      if (SUBJECTS[subject].includes(chunk)) {
        return subject;
      }
    }
  }

  return '';
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

type BooksList = {
  books: Book[];
};

type Book = {
  id?: string;
  title: string;
  description?: string;
  olid?: string;
  cover?: string;
  categories?: string[];
  author?: Author | null;
  subjects?: string;
};

type NYTimesBook = {
  title: string;
  author: string;
  book_image: string;
  description: string;
};

type OpenLibraryBook = {
  key: string;
  author_key: string[];
  title: string;
  subject_key: string[];
};

type Author = {
  id?: string;
  olid?: string;
  name: string;
  subjects?: string;
};

const PRIORITY_NY_TIMES = 4;

const SUBJECTS = require('./subjects.json');
