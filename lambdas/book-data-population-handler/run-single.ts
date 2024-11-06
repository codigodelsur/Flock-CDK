import { Callback, Context } from 'aws-lambda';
import { handler } from './function';

handler(
  {
    Records: [
      {
        messageId: '',
        receiptHandle: '',
        body: `{"Message": "f43d71ca-6da2-4d8f-8d9e-5dde5d904cbb"}`,
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
