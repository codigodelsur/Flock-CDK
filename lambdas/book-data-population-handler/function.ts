import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SQSEvent, SQSHandler } from 'aws-lambda';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import * as crypto from 'crypto';

const SUBJECTS = require('./subjects.json');

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

      const bookId = JSON.parse(body).Message;
      const dbBook = await getBookById(db, bookId);

      console.log('dbBook', dbBook);

      if (!dbBook) {
        continue;
      }

      const book: Book = await getOpenLibraryBook(dbBook);

      console.log('book with ol data', book);

      const { categories, name, cover, description } = await getGoogleData(
        book
      );

      const subjects = removeDuplicates(
        removeDuplicates(
          categories
            .map((category: string) => getSubjectsByCategory(category))
            .filter((category: string) => !!category)
        )
          .join(',')
          .split(',')
      ).join(',');

      book.description = description || '';
      book.name = name;
      book.subjects = subjects;
      book.cover = cover;

      console.log('book with google data', book);

      await uploadCover(book);

      if (book.author) {
        const author = await upsertAuthor(db, book.author);
        await updateBook(db, { ...book, author });
      } else {
        await updateBook(db, book);
      }

      console.timeLog('handler', 'update book finished');
    }
  } catch (e) {
    console.error(e);
  } finally {
    await db.end();
    console.timeEnd('handler');
  }
};

async function getBookById(db: Client, bookId: string): Promise<Book | null> {
  const { rows: books } = await db.query(
    `SELECT id, olid, name FROM "Books" b WHERE b."id" = $1`,
    [bookId]
  );

  if (books.length === 0) {
    return null;
  }

  return books[0];
}

async function getOpenLibraryBook(book: Book) {
  const workResponse = await fetch(
    `https://openlibrary.org/works/${book.olid}.json`
  );

  const work = await workResponse.json();

  const authorOlid =
    work.authors &&
    work.authors.length > 0 &&
    work.authors[0].author?.key?.replace('/authors/', '');

  return {
    id: book.id,
    olid: book.olid,
    author: await getOpenLibraryAuthor(authorOlid),
    name: book.name,
    description: '',
    subjects: '',
  };
}

async function getOpenLibraryAuthor(olid: string) {
  if (!olid) {
    return null;
  }

  const response = await fetch(`https://openlibrary.org/authors/${olid}.json`);
  const author = await response.json();

  return {
    olid,
    name: author.name,
  };
}

function getSubjectsByCategory(category: string) {
  const subjects = [];

  for (const subject in SUBJECTS) {
    for (const chunk of category.split(' / ')) {
      if (SUBJECTS[subject].includes(chunk)) {
        subjects.push(subject);
      }
    }
  }

  return removeDuplicates(subjects).join(',');
}

async function updateBook(db: Client, bookData: Book) {
  await db.query(
    `UPDATE "Books" SET description = $2, subjects = $3, "authorId" = $4, "updatedAt" = $5 WHERE id = $1`,
    [
      bookData.id,
      bookData.description,
      bookData.subjects,
      bookData.author?.id || null,
      new Date(),
    ]
  );
}

async function upsertAuthor(db: Client, author: Author) {
  const { rows: authors } = await db.query(
    `SELECT id, olid, name FROM "Authors" a WHERE a."olid" = $1`,
    [author.olid]
  );

  if (authors.length === 0) {
    const id = crypto.randomUUID();

    await db.query(
      `INSERT INTO "Authors" (id, olid, name, bio, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, author.olid, author.name, '', new Date(), new Date()]
    );

    return { ...author, id };
  }

  return authors[0];
}

async function getGoogleData(book: Book) {
  const params = [
    `q=intitle:${stringToUrl(book.name!)}+inauthor:${stringToUrl(
      book.author!.name
    )}`,
    'projection=full',
    'orderBy=newest',
    'langRestrict=en',
  ];

  const url = `https://www.googleapis.com/books/v1/volumes?${params.join('&')}`;

  const response = await fetch(url);
  const result = await response.json();

  if (!result.items || result.items.length === 0) {
    return { categories: [], cover: null, name: null, description: null };
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
      name: '',
      cover: '',
      description: '',
    };
  }

  return {
    categories: result.volumeInfo.categories || [],
    name: result.volumeInfo.title,
    cover: result.volumeInfo.imageLinks?.thumbnail
      .replaceAll('edge=curl&', '')
      .replaceAll('edge=curl', ''),
    description,
  };
}

async function uploadCover(book: Book) {
  const s3Client = new S3Client({});

  if (!book.cover) {
    return;
  }

  const coverResponse = await fetch(book.cover!);
  const file = await coverResponse.arrayBuffer();

  const command = new PutObjectCommand({
    Body: Buffer.from(file),
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

type Book = {
  id: string;
  olid: string;
  name?: string;
  author?: Author | null;
  subjects?: string;
  description?: string;
  cover?: string;
};

type Author = {
  id?: string;
  olid: string;
  name: string;
};
