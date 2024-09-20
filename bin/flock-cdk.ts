#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { FlockApiStack } from '../lib/flock-api-stack';
import { FlockWebStack } from '../lib/flock-web-stack';
import { FlockRecommendationStack } from '../lib/flock-recommendation-stack';
import { FlockBookDataPopulationStack } from '../lib/flock-book-data-population-stack';
import { FlockBookSyncStack } from '../lib/flock-book-sync-stack';
import { IBucket } from 'aws-cdk-lib/aws-s3';

const app = new cdk.App();

const REGION = 'us-east-1';
const ACCOUNT = '431027017019';
const env = { region: REGION, account: ACCOUNT };

const bookDataPopulationStackStage = new FlockBookDataPopulationStack(
  app,
  'FlockBookDataPopulationStack-Dev',
  'dev',
  {
    stackName: 'flock-book-data-population-dev',
    env,
  }
);

const bookDataPopulationStackDev = new FlockBookDataPopulationStack(
  app,
  'FlockBookDataPopulationStack-Stage',
  'stage',
  {
    stackName: 'flock-book-data-population-stage',
    env,
  }
);

const apiStackDev = new FlockApiStack(app, 'FlockApiStack-Dev', {
  stackName: 'flock-api-dev',
  env,
});

new FlockWebStack(app, 'FlockWebStack', {
  env,
});

const recommendationStack = new FlockRecommendationStack(
  app,
  'FlockRecommendationStack-Stage',
  'stage',
  {
    env,
  }
);

new FlockRecommendationStack(app, 'FlockRecommendationStack-Dev', 'dev', {
  stackName: 'flock-recommendation-dev',
  env,
});

const bookSyncStackDev = new FlockBookSyncStack(
  app,
  'FlockBookSyncStack-Dev',
  'dev',
  {
    stackName: 'flock-book-sync-dev',
    env,
    imagesBucket: apiStackDev.imagesBucket,
  }
);

export interface SyncStackProps extends cdk.StackProps {
  imagesBucket: IBucket;
}
