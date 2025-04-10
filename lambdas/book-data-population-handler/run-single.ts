import { Callback, Context } from 'aws-lambda';
import { handler } from './function';

handler(
  {
    Records: [
      {
        messageId: '',
        receiptHandle: '',
        body: `{"Message": "f0b68205-6365-4038-bb43-de7d4d5c3d4f"}`,
        attributes: {
          ApproximateReceiveCount: '',
          SentTimestamp: '',
          SenderId: '',
          ApproximateFirstReceiveTimestamp: '',
        },
        messageAttributes: {},
        md5OfBody: '',
        eventSource: '',
        eventSourceARN: '',
        awsRegion: '',
      },
    ],
  },
  {} as Context,
  {} as Callback
);
