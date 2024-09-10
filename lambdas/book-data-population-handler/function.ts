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
      const book = await getBookById(db, bookId);

      console.log('book', book);

      if (!book) {
        continue;
      }

      const bookData = await getOpenLibraryBook(book);

      console.log('bookData', bookData);

      if (bookData.author) {
        const author = await upsertAuthor(db, bookData.author);

        console.log('author', author);

        await updateBook(db, { ...bookData, author });
      } else {
        await updateBook(db, bookData);
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
    `SELECT id, olid FROM "Books" b WHERE b."id" = $1`,
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

  const editionsResponse = await fetch(
    `https://openlibrary.org/works/${book.olid}/editions.json?limit=500`
  );
  const editions = await editionsResponse.json();

  const bestEditions = editions.entries.filter(
    (entry: any) =>
      entry.description &&
      entry.languages &&
      entry.authors &&
      entry.authors.length > 0 &&
      entry.subjects &&
      entry.subjects.length > 0 &&
      entry.languages[0].key === '/languages/eng'
  );

  console.log('bestEditions', bestEditions);

  bestEditions.sort(
    (first: any, second: any) => second.revision - first.revision
  );

  const edition =
    bestEditions && bestEditions.length > 0 ? bestEditions[0] : null;

  let authorOlid;
  let subjects;
  let description;

  if (edition) {
    authorOlid = edition.authors[0].key?.replace('/authors/', '');

    subjects = edition.subjects
      .map((subject: string) => getSubjectByText(subject))
      .filter((subject: string) => !!subject);

    description =
      typeof edition.description === 'object'
        ? edition.description.value || ''
        : edition.description || '';
  } else {
    authorOlid =
      work.authors &&
      work.authors.length > 0 &&
      work.authors[0].author?.key?.replace('/authors/', '');

    subjects =
      work.subjects && work.subjects.length > 0
        ? work.subjects
            .map((subject: string) => getSubjectByText(subject))
            .filter((subject: string) => !!subject)
        : [];

    description =
      typeof work.description === 'object'
        ? work.description.value || ''
        : work.description || '';
  }

  return {
    id: book.id,
    olid: book.olid,
    author: await getOpenLibraryAuthor(authorOlid),
    subjects: subjects.join(','),
    description,
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

function getSubjectByText(text: string) {
  for (const subject in SUBJECTS) {
    if (text.includes(SUBJECTS[subject])) {
      return subject;
    }
  }

  return '';
}

async function updateBook(db: Client, bookData: Book) {
  await db.query(
    `UPDATE "Books" SET description = $2, "authorId" = $3, "updatedAt" = $4 WHERE id = $1`,
    [bookData.id, bookData.description, bookData.author?.id || null, new Date()]
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

type Book = {
  id: string;
  olid: string;
  author?: Author | null;
  subjects?: string;
  description?: string;
};

type Author = {
  id?: string;
  olid: string;
  name: string;
};
