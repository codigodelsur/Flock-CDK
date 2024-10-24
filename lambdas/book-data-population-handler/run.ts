import { Callback, Context } from 'aws-lambda';
import { handler } from './function';

handler(
  {
    Records: [
      {
        messageId: '',
        receiptHandle: '',
        body: `{"Message": "6713d97f-e1e7-42d8-983d-0e2bc8a8b78f"}`,
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
