import { Callback, Context } from 'aws-lambda';
import { handler } from './function';

handler(
  {
    Records: [
      {
        messageId: '',
        receiptHandle: '',
        body: `{"Message": "{\\"conversationId\\":\\"a8777a8c-3e8a-42f7-9ff9-70e9fa335402\\",\\"users\\":[\\"e418c428-e041-7084-82a5-3eb5c36c497e\\",\\"14b83458-3071-70c8-8d69-b50f937dd6e7\\"]}"}`,
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
