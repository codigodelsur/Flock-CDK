import { ScheduledEvent, ScheduledHandler } from 'aws-lambda';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import * as admin from 'firebase-admin';

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

  const firebaseConfig = {
    type: process.env.FIREBASE_TYPE,
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY,
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: process.env.FIREBASE_AUTH_URI,
    token_uri: process.env.FIREBASE_TOKEN_URI,
    messaging_sender_id: process.env.FIREBASE_SENDER_ID,
    auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_CERT_URL,
    client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
    universe_domain: process.env.FIREBASE_UNIVERSAL_DOMAIN,
  } as admin.ServiceAccount;

  const firebaseApp = admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig),
    databaseURL: `https://${firebaseConfig.projectId}.firebaseio.com`,
    storageBucket: `${firebaseConfig.projectId}.appspot.com`,
  });

  const firestore = firebaseApp.firestore();
  const messaging = firebaseApp.messaging();

  console.log('event', event);

  console.timeLog('handler', 'db connected');

  try {
    const usersWithoutOngoingChallenges =
      await getUsersWithoutOngoingChallenges(db);

    console.log('usersWithoutOngoingChallenges', usersWithoutOngoingChallenges);

    for (const user of usersWithoutOngoingChallenges) {
      const title = 'Start a new challenge!';
      const description =
        'Here you have some book recommendations for a challenge with your friends!';
      await sendPushNotificationToUser(
        user.id,
        title,
        description,
        'CHALLENGE_PROMO',
        messaging,
        firestore
      );

      await insertUserNotification(
        db,
        user.id,
        title,
        description,
        'CHALLENGE_PROMO'
      );
    }

    const usersWithoutConversations = await getUsersWithoutConversations(db);

    console.log('usersWithoutConversations', usersWithoutConversations);

    for (const user of usersWithoutConversations) {
      const title = 'Find a new friend!';
      const description =
        'Go to Find section and look the recommendations we have for you!';
      await sendPushNotificationToUser(
        user.id,
        title,
        description,
        'FIND_NEW_FRIEND',
        messaging,
        firestore
      );

      await insertUserNotification(
        db,
        user.id,
        title,
        description,
        'FIND_NEW_FRIEND'
      );
    }

    const usersWithContactRequests = await getUsersWithContactRequests(db);

    console.log('usersWithContactRequests', usersWithContactRequests);

    for (const user of usersWithContactRequests) {
      const title = 'Start chatting!';
      const description =
        'You have some friend request pending! Go check them out!';
      await sendPushNotificationToUser(
        user.id,
        title,
        description,
        'FIND_NEW_FRIEND',
        messaging,
        firestore
      );

      await insertUserNotification(
        db,
        user.id,
        title,
        description,
        'CONTACT_PENDING'
      );
    }
  } catch (e) {
    console.error(e);
  } finally {
    await db.end();
    console.timeEnd('handler');
  }
};

async function getUsersWithoutOngoingChallenges(db: Client) {
  const query = `
    select u.id from "Users" u where id not in (
    select "userId" from "UserChallenges" uc
    inner join "Challenges" c on c.id = uc."challengeId"
    where status = 'IN_PROGRESS')
    and id in (select "userId" from "UserConversations" uc)
  `;

  const result = await db.query(query);

  return result.rows;
}

async function getUsersWithoutConversations(db: Client) {
  const query = `
    select u.id from "Users" u where
    id not in (select "userId" from "UserConversations" uc) and
    id in (select "userId" from "UserRecommendations" where status = 'PENDING')
  `;

  const result = await db.query(query);

  return result.rows;
}

async function getUsersWithContactRequests(db: Client) {
  const query = `
    select u.id from "Users" u where id in (select "ContactRequests"."requestedUserId" from "ContactRequests")
  `;

  const result = await db.query(query);

  return result.rows;
}

async function sendPushNotificationToUser(
  userId: string,
  title: string,
  description: string,
  type: string,
  messaging: admin.messaging.Messaging,
  firestore: FirebaseFirestore.Firestore
) {
  const devices = await getUserDevices(userId, firestore);

  for (const device of devices) {
    try {
      await sendNotification(
        title,
        description,
        device.registrationToken,
        type,
        device.badgeCount ? device.badgeCount + 1 : 1,
        messaging
      );
    } catch (e) {
      console.error(e);
    }
  }

  await incrementBadgeCount(userId, 1, firestore);
}

async function getUserDevices(userId: string, db: FirebaseFirestore.Firestore) {
  const doc = db.collection('users').doc(userId);
  const user = await doc.get();

  const currentDevices = await user.get('devices');

  if (!currentDevices) {
    return [];
  }

  return currentDevices.map((item: any) => ({
    registrationToken: item.registrationToken,
    badgeCount: item.badgeCount,
  }));
}

function sendNotification(
  title: string,
  message: string,
  token: string,
  type: string,
  badge: number,
  client: admin.messaging.Messaging
) {
  console.log('Sending notification: %o', {
    token,
    title,
    message,
    type,
    badge,
  });

  return client.send({
    notification: {
      title,
      body: message,
    },
    token,
    data: {
      type,
    },
    apns: {
      payload: {
        aps: {
          badge,
        },
      },
    },
  });
}

async function incrementBadgeCount(
  userId: string,
  count: number = 1,
  db: FirebaseFirestore.Firestore
) {
  const doc = db.collection('users').doc(userId);
  const user = await doc.get();

  const currentDevices = await user.get('devices');
  const devicesToUpdate = [];

  if (!currentDevices) {
    return;
  }

  for (const device of currentDevices) {
    const currentBadgeCount = device.badgeCount || 0;
    const newBadgeCount = currentBadgeCount + count;
    devicesToUpdate.push({ ...device, badgeCount: newBadgeCount });
  }

  await doc.update('devices', devicesToUpdate);
}

async function insertUserNotification(
  db: Client,
  userId: string,
  title: string,
  description: string,
  type: string,
  bookCover: string | null = null,
  conversationId: string | null = null,
  groupId: string | null = null,
  postId: string | null = null,
  challengeId: string | null = null,
  creatorId: string | null = null,
  contactRequestId: string | null = null
) {
  const id = crypto.randomUUID();

  await db.query(
    `
    INSERT INTO "UserNotifications"
      (id, "userId", title, description, "isRead", type, "bookCover", "conversationId",
      "groupId", "postId", "challengeId", "creatorId", "contactRequestId", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      id,
      userId,
      title,
      description,
      false,
      type,
      bookCover,
      conversationId,
      groupId,
      postId,
      challengeId,
      creatorId,
      contactRequestId,
      new Date(),
      new Date(),
    ]
  );
}
