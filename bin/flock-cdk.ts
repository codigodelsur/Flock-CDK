#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { FlockApiStack } from '../lib/flock-api-stack';
import { FlockWebStack } from '../lib/flock-web-stack';
import { FlockRecommendationStack } from '../lib/flock-recommendation-stack';
import { FlockBookDataPopulationStack } from '../lib/flock-book-data-population-stack';
import { FlockBookSyncStack } from '../lib/flock-book-sync-stack';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { ITopic } from 'aws-cdk-lib/aws-sns';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { IVpc } from 'aws-cdk-lib/aws-ec2';
import { FlockNotificationsStack } from '../lib/flock-notifications-stack';
import { FlockBookRefreshingStack } from '../lib/flock-book-refreshing-stack';

const app = new cdk.App();

const REGION = 'us-east-1';
const ACCOUNT = '431027017019';
const env = { region: REGION, account: ACCOUNT };

const apiStackDev = new FlockApiStack(app, 'FlockApiStack-Dev', 'dev', {
  stackName: 'flock-api-dev',
  env,
});

const apiStackProd = new FlockApiStack(app, 'FlockApiStack-Prod', 'prod', {
  stackName: 'flock-api-prod',
  env,
});

new FlockRecommendationStack(app, 'FlockRecommendationStack-Dev', 'dev', {
  stackName: 'flock-recommendation-dev',
  env,
  userUpdatedTopic: apiStackDev.userUpdatedTopic,
  conversationCreatedTopic: apiStackDev.conversationCreatedTopic,
});

new FlockRecommendationStack(app, 'FlockRecommendationStack-Stage', 'stage', {
  env,
});

new FlockRecommendationStack(app, 'FlockRecommendationStack-Prod', 'prod', {
  stackName: 'flock-recommendation-prod',
  env,
  userUpdatedTopic: apiStackProd.userUpdatedTopic,
  conversationCreatedTopic: apiStackProd.conversationCreatedTopic,
  vpc: apiStackProd.vpc,
  masterUserSecret: apiStackProd.masterUserSecret,
});

new FlockBookDataPopulationStack(
  app,
  'FlockBookDataPopulationStack-Dev',
  'dev',
  {
    stackName: 'flock-book-data-population-dev',
    env,
    imagesBucket: apiStackDev.imagesBucket,
    bookCreatedTopic: apiStackDev.bookCreatedTopic,
  }
);

new FlockBookDataPopulationStack(
  app,
  'FlockBookDataPopulationStack-Stage',
  'stage',
  {
    stackName: 'flock-book-data-population-stage',
    env,
  }
);

new FlockBookDataPopulationStack(
  app,
  'FlockBookDataPopulationStack-Prod',
  'prod',
  {
    stackName: 'flock-book-data-population-prod',
    env,
    imagesBucket: apiStackProd.imagesBucket,
    vpc: apiStackProd.vpc,
    masterUserSecret: apiStackProd.masterUserSecret,
    bookCreatedTopic: apiStackProd.bookCreatedTopic,
  }
);

new FlockWebStack(app, 'FlockWebStack', 'prod', {
  env,
});

new FlockWebStack(app, 'FlockWebStack-Stage', 'stage', {
  env,
});

new FlockBookSyncStack(app, 'FlockBookSyncStack-Dev', 'dev', {
  stackName: 'flock-book-sync-dev',
  env,
  imagesBucket: apiStackDev.imagesBucket,
});

new FlockBookSyncStack(app, 'FlockBookSyncStack-Stage', 'stage', {
  stackName: 'flock-book-sync-stage',
  env,
});

new FlockBookSyncStack(app, 'FlockBookSyncStack-Prod', 'prod', {
  stackName: 'flock-book-sync-prod',
  env,
  imagesBucket: apiStackProd.imagesBucket,
  masterUserSecret: apiStackProd.masterUserSecret,
  vpc: apiStackProd.vpc,
});

new FlockNotificationsStack(app, 'FlockNotificationsStack-Dev', 'dev', {
  stackName: 'flock-notifications-dev',
  env,
});

new FlockBookRefreshingStack(app, 'FlockBookRefreshingStack-Dev', 'dev', {
  stackName: 'flock-book-refreshing-dev',
  env,
  imagesBucket: apiStackDev.imagesBucket,
});

new FlockBookRefreshingStack(app, 'FlockBookRefreshingStack-Stage', 'stage', {
  stackName: 'flock-book-refreshing-stage',
  env,
});

new FlockBookRefreshingStack(app, 'FlockBookRefreshingStack-Prod', 'prod', {
  stackName: 'flock-book-refreshing-prod',
  env,
  imagesBucket: apiStackProd.imagesBucket,
  masterUserSecret: apiStackProd.masterUserSecret,
  vpc: apiStackProd.vpc,
});

export interface RecommendationStackProps extends cdk.StackProps {
  userUpdatedTopic?: ITopic;
  conversationCreatedTopic?: ITopic;
  masterUserSecret?: ISecret;
  vpc?: IVpc;
}

export interface SyncStackProps extends cdk.StackProps {
  imagesBucket?: IBucket;
  masterUserSecret?: ISecret;
  vpc?: IVpc;
}

export interface BookRefreshingStackProps extends cdk.StackProps {
  imagesBucket?: IBucket;
  masterUserSecret?: ISecret;
  vpc?: IVpc;
}

export interface NotificationsStackProps extends cdk.StackProps {
  imagesBucket?: IBucket;
  masterUserSecret?: ISecret;
  vpc?: IVpc;
}

export interface BookDataPopulationStackProps extends cdk.StackProps {
  imagesBucket?: IBucket;
  vpc?: IVpc;
  masterUserSecret?: ISecret;
  bookCreatedTopic?: ITopic;
}

export interface ApiStackProps extends cdk.StackProps {}
