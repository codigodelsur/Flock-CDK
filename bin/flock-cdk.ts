#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { FlockApiStack } from '../lib/flock-api-stack';
import { FlockWebStack } from '../lib/flock-web-stack';
import { FlockRecommendationStack } from '../lib/flock-recommendation-stack';
import { FlockBookDataPopulationStack } from '../lib/flock-book-data-population-stack';
import { FlockBookSyncStack } from '../lib/flock-book-sync-stack';
import { Bucket, IBucket } from 'aws-cdk-lib/aws-s3';
import { ITopic } from 'aws-cdk-lib/aws-sns';

const app = new cdk.App();

const REGION = 'us-east-1';
const ACCOUNT = '431027017019';
const env = { region: REGION, account: ACCOUNT };

const bookDataPopulationStackStage = new FlockBookDataPopulationStack(
  app,
  'FlockBookDataPopulationStack-Stage',
  'stage',
  {
    stackName: 'flock-book-data-population-stage',
    env,
  }
);

new FlockRecommendationStack(app, 'FlockRecommendationStack-Stage', 'stage', {
  env,
});

const recommendationStackDev = new FlockRecommendationStack(
  app,
  'FlockRecommendationStack-Dev',
  'dev',
  {
    stackName: 'flock-recommendation-dev',
    env,
  }
);

const apiStackDev = new FlockApiStack(app, 'FlockApiStack-Dev', {
  stackName: 'flock-api-dev',
  env,
  userUpdatedTopic: recommendationStackDev.userUpdatedTopic,
  conversationCreatedTopic: recommendationStackDev.conversationCreatedTopic,
});

const bookDataPopulationStackDev = new FlockBookDataPopulationStack(
  app,
  'FlockBookDataPopulationStack-Dev',
  'dev',
  {
    stackName: 'flock-book-data-population-dev',
    env,
    imagesBucket: apiStackDev.imagesBucket,
  }
);

new FlockWebStack(app, 'FlockWebStack', 'prod', {
  env,
});

new FlockWebStack(app, 'FlockWebStack-Stage', 'stage', {
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

const bookSyncStackStage = new FlockBookSyncStack(
  app,
  'FlockBookSyncStack-Stage',
  'stage',
  {
    stackName: 'flock-book-sync-stage',
    env,
  }
);

export interface SyncStackProps extends cdk.StackProps {
  imagesBucket?: IBucket;
}

export interface BookDataPopulationStackProps extends cdk.StackProps {
  imagesBucket?: IBucket;
}

export interface ApiStackProps extends cdk.StackProps {
  userUpdatedTopic?: ITopic;
  conversationCreatedTopic?: ITopic;
}
