#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { FlockApiStack } from '../lib/flock-api-stack';
import { FlockWebStack } from '../lib/flock-web-stack';
import { FlockRecommendationStack } from '../lib/flock-recommendation-stack';
import { FlockBookDataPopulationStack } from '../lib/flock-book-data-population-stack';

const app = new cdk.App();

const REGION = 'us-east-1';
const ACCOUNT = '431027017019';
const env = { region: REGION, account: ACCOUNT };

const bookDataPopulationStack = new FlockBookDataPopulationStack(
  app,
  'FlockBookDataPopulationStack-Dev',
  'dev',
  {
    stackName: 'flock-book-data-population-dev',
    env,
  }
);

new FlockApiStack(app, 'FlockApiStack-Dev', {
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
