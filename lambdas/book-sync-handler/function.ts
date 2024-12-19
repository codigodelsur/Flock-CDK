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
    nyTimesBooks.map(async (newBook: NYTimesBook) => {
      const book: Book = await getISBNDBBook(newBook);

      if (book.title === 'Untitled' || !book.cover) {
        return null;
      }

      try {
        book.author = await getOpenLibraryAuthorByBook(newBook);
      } catch (e) {
        console.error(e);
        return null;
      }

      if (!book.author) {
        return null;
      }

      const dbBook = await getBookByISBN(db, book.isbn!);

      if (dbBook) {
        return null;
      }

      return {
        ...book,
        author: { ...book.author, subjects: book.subjects },
      };
    })
  );

  console.log('books', books);

  try {
    for (const book of books) {
      if (!book || !book.author) {
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

async function getISBNDBBook(book: NYTimesBook): Promise<Book> {
  if (!book.primary_isbn13) {
    return { ...book, author: null };
  }

  const response = await fetch(
    `${process.env.ISBNDB_API_URL}/book/${book.primary_isbn13}`,
    { headers: { Authorization: process.env.ISBNDB_API_KEY } }
  );

  const { book: apiBook } = await response.json();

  if (!apiBook || isBoxSet(apiBook)) {
    return { ...book, author: null };
  }

  const subjects = apiBook.subjects
    ? removeDuplicates(
        removeDuplicates(
          apiBook.subjects
            .map((category: string) => getSubjectsByCategory(category))
            .filter((category: string) => !!category)
        )
          .join(',')
          .split(',')
      ).join(',')
    : '';

  return {
    ...book,
    isbn: book.primary_isbn13,
    cover: apiBook.image,
    title: apiBook.title,
    description: escapeText(apiBook.synopsis),
    subjects,
    author: null,
  };
}

function escapeText(string: string) {
  if (!string) {
    return '';
  }

  return string.replaceAll(/(<[^>]+>)*/g, '');
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

async function getOpenLibraryAuthorByBook(
  book: NYTimesBook
): Promise<Author | null> {
  const authorOlid = await getOpenLibraryAuthorIdByISBN(book.primary_isbn13);

  if (!authorOlid) {
    return null;
  }

  return {
    olid: authorOlid,
    name: book.author,
  };
}

async function getOpenLibraryAuthorIdByISBN(isbn: string) {
  const workResponse = await fetch(`https://openlibrary.org/isbn/${isbn}.json`);

  const work = await workResponse.json();

  if (!work || !work.authors) {
    return;
  }

  return work.authors[0].key.replaceAll('/authors/', '');
}

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

async function getNewYorkTimesBooks(): Promise<NYTimesBook[]> {
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
      primary_isbn13: book.primary_isbn13,
    }));
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
      (id, isbn, name, description, subjects, source, "authorId", priority, olid, "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `,
    [
      id,
      book.isbn,
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

async function getBookByISBN(db: Client, isbn: string) {
  const { rows: books } = await db.query(
    `SELECT id, isbn FROM "Books" b WHERE b."isbn" = $1`,
    [isbn]
  );

  if (books.length > 0) {
    return books[0];
  } else {
    return null;
  }
}

function removeDuplicates(array: string[]) {
  return Array.from(new Set(array));
}

function isBoxSet(book: { title: string; edition?: string | number }) {
  const boxSetTerms = [
    'Trilogy',
    'Books Set',
    'Books Collection Set',
    'Box Set',
    'Special Collector',
    'Ebook Collection',
  ];

  const isBoxSetEdition =
    book.edition &&
    typeof book.edition === 'string' &&
    book.edition.includes('Boxed Set');

  return (
    boxSetTerms.some((term) => book.title.includes(term)) || isBoxSetEdition
  );
}

type BooksList = {
  books: Book[];
};

type Book = {
  id?: string;
  isbn?: string;
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
  primary_isbn13: string;
  description: string;
};

type Author = {
  id?: string;
  olid?: string;
  name?: string;
  subjects?: string;
};

const PRIORITY_NY_TIMES = 4;

const SUBJECTS = require('./subjects.json');
