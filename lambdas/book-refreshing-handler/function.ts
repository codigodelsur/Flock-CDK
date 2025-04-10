import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ScheduledEvent, ScheduledHandler } from 'aws-lambda';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import sharp from 'sharp';

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

  console.timeLog('handler', 'db connected');

  try {
    const badCoverBooks = await getBooksWithBadCovers(db);
    const refreshedBooks = [];

    console.log('Bad Cover Books: %d', badCoverBooks.length);

    for (const book of badCoverBooks) {
      const apiBook: Book = await getISBNDBBook(book);
      console.log('apiBook', apiBook);

      const result = await uploadCover(apiBook);

      if (result.status === 'UPLOADED') {
        refreshedBooks.push(apiBook);
        await updateDBBookCover(db, apiBook);
      }
    }

    console.log('Refreshed Books: %d', refreshedBooks.length);
  } catch (e) {
    console.error(e);
  } finally {
    await db.end();
    console.timeEnd('handler');
  }
};

async function getBooksWithBadCovers(db: Client): Promise<DBBook[]> {
  const { rows: books } = await db.query(
    `SELECT id, isbn FROM "Books" b WHERE b."goodCover" = false AND isbn != '' AND isbn IS NOT NULL`
  );

  return books;
}

async function getISBNDBBook(book: DBBook): Promise<Book> {
  try {
    const response = await fetch(
      `${process.env.ISBNDB_API_URL}/book/${book.isbn}`,
      { headers: { Authorization: process.env.ISBNDB_API_KEY } }
    );

    if (response.status !== 200) {
      return { ...book };
    }

    const { book: apiBook } = await response.json();

    return {
      ...book,
      cover: apiBook.image,
    };
  } catch (e) {
    console.error(e);
  }

  return { ...book, cover: '' };
}

async function uploadCover(book: Book) {
  const s3Client = new S3Client({});

  if (!book.cover) {
    return { status: 'NOT_FOUND' };
  }

  const coverResponse = await fetch(book.cover!);
  const file = await coverResponse.arrayBuffer();

  if (file.byteLength < 5_000) {
    console.log(
      `BAD_QUALITY: Byte Length ${file.byteLength}, URL: ${book.cover}`
    );
    return { status: 'BAD_QUALITY' };
  }

  const resizedFile = await sharp(file).resize(400).toBuffer();

  const command = new PutObjectCommand({
    Body: resizedFile,
    Bucket: process.env.IMAGES_BUCKET,
    Key: `covers/${book.id}.jpg`,
  });

  console.log(`Uploading cover ${book.id}.jpg ...`);

  await s3Client.send(command);

  return { status: 'UPLOADED' };
}

function updateDBBookCover(db: Client, book: Book) {
  return db.query(`UPDATE "Books" SET "goodCover" = true WHERE id = $1`, [
    book.id,
  ]);
}

type DBBook = {
  id: string;
  isbn: string;
};

type Book = {
  id?: string;
  isbn?: string;
  cover?: string;
};
