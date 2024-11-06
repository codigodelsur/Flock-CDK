import { Callback, Context } from 'aws-lambda';
import { handler } from './function';

handler(
  {
    Records: [
      {
        messageId: '',
        receiptHandle: '',
        body: `{"Message": "[\\"6ddbb613-1232-456f-aef5-3825e2f5157d\\",\\"1c1a716c-64ca-4a12-afce-7e6ffc6097b4\\",\\"8e9bbb3f-efcd-4d18-82e5-4a0dd41d824e\\"]"}`,
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
