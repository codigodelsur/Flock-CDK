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
    for (const record of event.Records) {
      const { body } = record;

      const message = JSON.parse(body).Message;

      const item = isUUID(message) ? message : JSON.parse(message);

      const bookIds = Array.isArray(item) ? item : [item];

      console.log('bookIds', bookIds);

      for (const bookId of bookIds) {
        const dbBook = await getBookById(db, bookId);

        console.log('dbBook', dbBook);

        if (!dbBook) {
          continue;
        }

        const book: Book = await getISBNDBBook(dbBook);
        console.log('book with ISBNdb data', book);

        book.author = await getOpenLibraryAuthorByBook(book);
        console.log('book with OL data', book);

        await uploadCover(book);

        if (book.author) {
          const author = await upsertAuthor(db, book.author, book.subjects!);
          await updateBook(db, { ...book, author });
        } else {
          await updateBook(db, book);
        }
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
    `SELECT id, olid, isbn, name FROM "Books" b WHERE b."id" = $1`,
    [bookId]
  );

  if (books.length === 0) {
    return null;
  }

  return books[0];
}

async function getOpenLibraryAuthorByBook(book: Book) {
  const olid = await getOpenLibraryWorkIdByISBN(book.isbn!);

  if (!olid) {
    return getOpenLibraryAuthorByName(book.authorName!);
  }

  const workResponse = await fetch(
    `https://openlibrary.org/works/${olid}.json`
  );

  const work = await workResponse.json();

  let authorOlid;

  authorOlid =
    work.authors &&
    work.authors.length > 0 &&
    work.authors[0].author?.key?.replaceAll('/authors/', '');

  return getOpenLibraryAuthor(authorOlid);
}

async function getOpenLibraryWorkIdByISBN(isbn: string) {
  const workResponse = await fetch(`https://openlibrary.org/isbn/${isbn}.json`);

  if (workResponse.status !== 200) {
    return;
  }

  const work = await workResponse.json();

  return work.works[0].key.replaceAll('/works/', '');
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

async function getOpenLibraryAuthorByName(name: string) {
  const response = await fetch(
    `https://openlibrary.org/search/authors.json?q=${stringToUrl(name)}`
  );
  const result = await response.json();

  if (!result.docs || result.docs.length === 0) {
    return;
  }

  return {
    olid: result.docs[0].key,
    name,
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
    `UPDATE "Books" SET name = $2, description = $3, subjects = $4, "authorId" = $5, "updatedAt" = $6 WHERE id = $1`,
    [
      bookData.id,
      bookData.title,
      bookData.description,
      bookData.subjects,
      bookData.author?.id || null,
      new Date(),
    ]
  );
}

async function upsertAuthor(db: Client, author: Author, subjects: string) {
  const { rows: authors } = await db.query(
    `SELECT id, olid, name FROM "Authors" a WHERE a."olid" = $1`,
    [author.olid]
  );

  if (authors.length === 0) {
    const id = crypto.randomUUID();

    await db.query(
      `INSERT INTO "Authors" (id, olid, name, subjects, bio, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, author.olid, author.name, subjects, '', new Date(), new Date()]
    );

    return { ...author, id };
  }

  return authors[0];
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

function removeDuplicates(array: string[]) {
  return Array.from(new Set(array));
}

function isUUID(uuid: string) {
  const result = uuid.match(
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  );

  if (result === null) {
    return false;
  }

  return true;
}

async function getISBNDBBook(book: Book) {
  if (!book.isbn) {
    return book;
  }

  const response = await fetch(
    `${process.env.ISBNDB_API_URL}/book/${book.isbn}`,
    { headers: { Authorization: process.env.ISBNDB_API_KEY } }
  );

  const { book: apiBook } = await response.json();

  const subjects = removeDuplicates(
    removeDuplicates(
      apiBook.subjects
        .map((category: string) => getSubjectsByCategory(category))
        .filter((category: string) => !!category)
    )
      .join(',')
      .split(',')
  ).join(',');

  return {
    ...book,
    cover: apiBook.image,
    title: apiBook.title,
    authorName: apiBook.authors[0],
    description: apiBook.synopsis,
    subjects,
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
  id: string;
  olid?: string;
  isbn?: string;
  name?: string;
  title?: string;
  author?: Author | null;
  subjects?: string;
  description?: string;
  cover?: string;
  authorName?: string;
};

type Author = {
  id?: string;
  olid?: string;
  name: string;
};
