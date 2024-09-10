import { SQSEvent, SQSHandler } from 'aws-lambda';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

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

      const userId = JSON.parse(body).Message;
      const user = await getUser(db, userId);

      console.timeLog('handler', 'get user finished');

      const userCurrentlyReadingBooks = user.books.filter(
        (book: UserBook) => book.category === 'CURRENTLY_READING'
      );
      const userWantToReadBooks = user.books.filter(
        (book: UserBook) => book.category === 'WANT_TO_READ'
      );
      const userFavoriteBooks = user.books.filter(
        (book: UserBook) => book.category === 'FAVORITE'
      );

      const candidates = await getCandidates(db, userId);

      console.timeLog('handler', 'get candidates finished');

      const userRecommendations = [];
      const userRecommendationsToDelete = [];
      const candidateRecommendations = [];
      const candidateRecommendationsToDelete = [];

      console.log('user %o', user);
      console.log('candidates %o', candidates);

      for (const candidate of candidates) {
        if (!isCorrectAge(user, candidate)) {
          userRecommendationsToDelete.push({
            userId: userId,
            recommendedUserId: candidate.id,
            score: 0,
          });
          candidateRecommendationsToDelete.push({
            userId: candidate.id,
            recommendedUserId: userId,
            score: 0,
          });

          continue;
        }

        const score = calculateScore(
          {
            ...user,
            currentlyReadingBooks: userCurrentlyReadingBooks,
            wantToReadBooks: userWantToReadBooks,
            favoriteBooks: userFavoriteBooks,
          } as User,
          candidate as User
        );

        userRecommendations.push({
          userId: userId,
          recommendedUserId: candidate.id,
          score,
        });

        candidateRecommendations.push({
          userId: candidate.id,
          recommendedUserId: userId,
          score,
        });
      }

      console.log('userRecommendations %o', userRecommendations);
      console.log('candidateRecommendations %o', candidateRecommendations);
      console.log(
        'userRecommendationsToDelete %o',
        userRecommendationsToDelete
      );
      console.log(
        'candidateRecommendationsToDelete %o',
        candidateRecommendationsToDelete
      );

      for (const recommendation of userRecommendations) {
        await insertRecommendation(db, recommendation);
      }

      for (const recommendation of userRecommendationsToDelete) {
        await deleteRecommendation(db, recommendation);
      }

      for (const recommendation of candidateRecommendations) {
        await insertRecommendation(db, recommendation);
      }

      for (const recommendation of candidateRecommendationsToDelete) {
        await deleteRecommendation(db, recommendation);
      }
    }
  } catch (e) {
    console.error(e);
  } finally {
    await db.end();
    console.timeEnd('handler');
  }
};

function isCorrectAge(user: User, candidate: User) {
  const userAge = calculateAge(user.birthDate);
  const candidateAge = calculateAge(candidate.birthDate);

  if (userAge === -1 || candidateAge === -1) {
    return false;
  }

  if (userAge < 18) {
    return candidateAge < 18;
  }

  if (userAge <= 25) {
    return candidateAge <= 25 && candidateAge >= 18;
  }

  return candidateAge > 25;
}

function calculateScore(user: User, candidate: User) {
  const currentlyReadingScore = getScoreByCategory(
    user.currentlyReadingBooks!,
    candidate.books,
    'CURRENTLY_READING',
    1000
  );

  const wantToReadScore = getScoreByCategory(
    user.wantToReadBooks!,
    candidate.books,
    'WANT_TO_READ',
    100
  );

  const favoriteScore = getScoreByCategory(
    user.favoriteBooks!,
    candidate.books,
    'FAVORITE',
    10
  );

  const favoriteGenreScore = getScoreByFavoriteGenres(
    user.favoriteGenres,
    candidate.favoriteGenres,
    5
  );

  const favoriteAuthorScore = getScoreByFavoriteAuthors(
    user.favoriteAuthors,
    candidate.favoriteAuthors,
    5
  );

  return (
    currentlyReadingScore +
    wantToReadScore +
    favoriteScore +
    favoriteGenreScore +
    favoriteAuthorScore
  );
}

function getScoreByCategory(
  userBooks: UserBook[],
  candidateBooks: UserBook[],
  category: UserBookCategory,
  categoryScore: number
) {
  const candidateFilteredBooks = candidateBooks.filter(
    (book: UserBook) => book.category === category
  );

  return userBooks.reduce((totalScore: number, userBook: UserBook) => {
    return (
      candidateFilteredBooks.filter(
        (book: UserBook) => book.bookId === userBook.bookId
      ).length *
        categoryScore +
      totalScore
    );
  }, 0);
}

function getScoreByFavoriteGenres(
  userFavoriteGenres: UserFavoriteGenre[],
  candidateFavoriteGenres: UserFavoriteGenre[],
  genreScore: number
) {
  return userFavoriteGenres.reduce(
    (totalScore: number, userFavoriteGenre: UserFavoriteGenre) => {
      return (
        candidateFavoriteGenres.filter(
          (favoriteGenre: UserFavoriteGenre) =>
            favoriteGenre.genreId === userFavoriteGenre.genreId
        ).length *
          genreScore +
        totalScore
      );
    },
    0
  );
}

function getScoreByFavoriteAuthors(
  userFavoriteAuthors: UserFavoriteAuthor[],
  candidateFavoriteAuthors: UserFavoriteAuthor[],
  authorsScore: number
) {
  return userFavoriteAuthors.reduce(
    (totalScore: number, userFavoriteAuthor: UserFavoriteAuthor) => {
      return (
        candidateFavoriteAuthors.filter(
          (favoriteAuthor: UserFavoriteAuthor) =>
            favoriteAuthor.authorId === userFavoriteAuthor.authorId
        ).length *
          authorsScore +
        totalScore
      );
    },
    0
  );
}

async function getUser(db: Client, userId: string) {
  const { rows: users } = await db.query(
    `SELECT "birthDate" FROM "Users" u WHERE u."id" = $1`,
    [userId]
  );

  const birthDate = users && users.length > 0 && users[0].birthDate;

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

  return { id: userId, birthDate, books, favoriteAuthors, favoriteGenres };
}

async function getCandidates(db: Client, userId: string) {
  const { rows: candidateIds } = await db.query(
    `
      SELECT u.id FROM "Users" u
      WHERE u.id != $1 AND u."deletedAt" IS NULL
    `,
    [userId]
  );

  return Promise.all(
    candidateIds.map((row) => {
      return getUser(db, row.id);
    })
  );
}

async function insertRecommendation(
  db: Client,
  userRecommendation: UserRecommendation
) {
  await db.query(
    `
      INSERT INTO "UserRecommendations" ("userId", "recommendedUserId", "score")
      VALUES ($1, $2, $3)
      ON CONFLICT ("userId", "recommendedUserId") DO UPDATE SET score = $3
    `,
    [
      userRecommendation.userId,
      userRecommendation.recommendedUserId,
      userRecommendation.score,
    ]
  );
}

async function deleteRecommendation(
  db: Client,
  userRecommendation: UserRecommendation
) {
  await db.query(
    `DELETE FROM "UserRecommendations" WHERE "userId" = $1 AND "recommendedUserId" = $2`,
    [userRecommendation.userId, userRecommendation.recommendedUserId]
  );
}

function calculateAge(birthDate: Date): number {
  if (!birthDate) {
    return -1;
  }

  // Get the current date
  const today = new Date();

  // Calculate the age
  let age = today.getFullYear() - birthDate.getFullYear();

  // Adjust if the birthdate hasn't occurred yet this year
  const monthDifference = today.getMonth() - birthDate.getMonth();
  const dayDifference = today.getDate() - birthDate.getDate();

  if (monthDifference < 0 || (monthDifference === 0 && dayDifference < 0)) {
    age--;
  }

  return age;
}

type UserBook = {
  bookId: string;
  category: UserBookCategory;
};

type UserFavoriteAuthor = {
  authorId: string;
};

type UserFavoriteGenre = {
  genreId: string;
};

type UserBookCategory = 'CURRENTLY_READING' | 'WANT_TO_READ' | 'FAVORITE';

type User = {
  id: string;
  birthDate: Date;
  books: UserBook[];
  currentlyReadingBooks?: UserBook[];
  wantToReadBooks?: UserBook[];
  favoriteBooks?: UserBook[];
  favoriteGenres: UserFavoriteGenre[];
  favoriteAuthors: UserFavoriteAuthor[];
};

type UserRecommendation = {
  userId: string;
  recommendedUserId: string;
  score: number;
};
