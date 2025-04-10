import { Callback, Context } from 'aws-lambda';
import { handler } from './function';

handler(
  {
    version: '0',
    id: 'bd43d058-55a6-c451-360b-d4e450780934',
    'detail-type': 'Scheduled Event',
    source: 'aws.events',
    account: '431027017019',
    time: '2024-09-18T18:28:00Z',
    region: 'us-east-1',
    resources: [
      'arn:aws:events:us-east-1:431027017019:rule/flock-book-sync-dev-crondevD12E1C67-RG7b5TrsMIy4',
    ],
    detail: {},
  },
  {} as Context,
  {} as Callback
);
