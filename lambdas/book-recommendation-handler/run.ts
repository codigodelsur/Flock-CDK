import { Callback, Context } from 'aws-lambda';
import { handler } from './function';

handler(
  {
    Records: [
      {
        messageId: '',
        receiptHandle: '',
        body: `{"Message": "{\\"conversationId\\":\\"b9b9643b-4691-472d-bd2f-d51e2e66c4ac\\",\\"users\\":[\\"e4e874d8-d091-706f-b5fe-19ffce1209c6\\",\\"84d81428-1041-70e0-7c43-51f75342d754\\"]}"}`,
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
