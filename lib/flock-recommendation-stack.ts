import * as cdk from 'aws-cdk-lib';
import { Port, SecurityGroup, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { DatabaseInstance, DatabaseInstanceEngine } from 'aws-cdk-lib/aws-rds';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { ISecret, Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { SqsSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import path = require('path');
import 'dotenv/config';
import { RecommendationStackProps } from '../bin/flock-cdk';

export class FlockRecommendationStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    workload: string,
    props: RecommendationStackProps
  ) {
    super(scope, id, props);

    const dbCredentials = getDBCredentials(workload, props.masterUserSecret!);

    if (workload === 'stage') {
      props.userUpdatedTopic = new Topic(this, 'user-profile-updated-topic', {
        displayName: 'Updated User Profile',
        topicName: `user-profile-updated-topic-${workload}`,
      });

      props.conversationCreatedTopic = new Topic(
        this,
        'conversation-created-topic',
        {
          displayName: 'Conversation Created',
          topicName: `conversation-created-topic-${workload}`,
        }
      );
    }

    // SQS Queue
    const userUpdatedQueue = new Queue(this, 'user-profile-updated-queue', {
      receiveMessageWaitTime: cdk.Duration.seconds(2),
      visibilityTimeout: cdk.Duration.seconds(120),
      // add dead-letter queue
    });

    props.userUpdatedTopic!.addSubscription(
      new SqsSubscription(userUpdatedQueue)
    );

    // SQS Queue
    const conversationCreatedQueue = new Queue(
      this,
      'conversation-created-queue',
      {
        receiveMessageWaitTime: cdk.Duration.seconds(2),
        visibilityTimeout: cdk.Duration.seconds(120),
        // add dead-letter queue
      }
    );

    props.conversationCreatedTopic!.addSubscription(
      new SqsSubscription(conversationCreatedQueue)
    );

    const vpc = Vpc.fromLookup(this, 'vpc', { isDefault: true });

    const securityGroup = SecurityGroup.fromSecurityGroupId(
      this,
      'security-group',
      'sg-08800ce1e272b7f43'
    );

    const rdsInstance = DatabaseInstance.fromDatabaseInstanceAttributes(
      this,
      'rds',
      {
        instanceEndpointAddress:
          'flock-db-stage.cvi6m0giyhbg.us-east-1.rds.amazonaws.com',
        instanceIdentifier: 'flock-db-stage',
        port: 5432,
        securityGroups: [securityGroup],
        engine: DatabaseInstanceEngine.POSTGRES,
      }
    );

    const secret =
      workload === 'stage' &&
      new Secret(this, 'rds-credentials-secret', {
        secretName: `rds-credentials-secret-${workload}`,
        secretObjectValue: {
          username: new cdk.SecretValue(process.env.DB_USER),
          password: new cdk.SecretValue(process.env.DB_PASS),
        },
      });

    const dbConnectionGroup =
      workload === 'stage' &&
      new SecurityGroup(this, 'Proxy to DB Connection', {
        vpc,
      });

    const lambdaToRDSProxyGroup =
      workload === 'stage' &&
      new SecurityGroup(this, 'Lambda to RDS Proxy Connection', {
        vpc,
      });

    if (workload === 'stage' && dbConnectionGroup && lambdaToRDSProxyGroup) {
      dbConnectionGroup.addIngressRule(
        dbConnectionGroup,
        Port.tcp(5432),
        'allow db connection'
      );

      dbConnectionGroup.addIngressRule(
        lambdaToRDSProxyGroup,
        Port.tcp(5432),
        'allow lambda connection'
      );
    }

    const rdsProxy =
      workload === 'stage' &&
      secret &&
      dbConnectionGroup &&
      rdsInstance.addProxy(`${id}-proxy`, {
        vpc,
        secrets: [secret],
        securityGroups: [dbConnectionGroup],
        requireTLS: true,
      });

    const userRecommendationProjectRoot = path.resolve(
      __dirname,
      '../lambdas/user-recommendation-handler'
    );

    const userRecommendationHandler = new NodejsFunction(
      this,
      `user-recommendation-handler-${workload}`,
      {
        functionName: `user-recommendation-handler-${workload}`,
        projectRoot: userRecommendationProjectRoot,
        entry: path.join(userRecommendationProjectRoot, 'function.ts'),
        depsLockFilePath: path.join(
          userRecommendationProjectRoot,
          'package-lock.json'
        ),
        runtime: Runtime.NODEJS_20_X,
        vpc: workload === 'prod' ? props.vpc : undefined,
        vpcSubnets:
          workload === 'prod'
            ? {
                subnetType: SubnetType.PRIVATE_WITH_EGRESS,
              }
            : undefined,
        allowPublicSubnet: true,
        timeout: cdk.Duration.seconds(120),
        // securityGroups:
        //   workload === 'stage' && lambdaToRDSProxyGroup
        //     ? [lambdaToRDSProxyGroup]
        //     : undefined,
        environment: {
          DB_HOST: dbCredentials.host,
          // workload === 'stage' && rdsProxy
          //   ? rdsProxy.endpoint
          //   : ,
          // RDS_SECRET_NAME: `rds-credentials-secret-${workload}`,
          DB_NAME: dbCredentials.name,
          DB_USER: dbCredentials.username,
          DB_PASS: dbCredentials.password,
        },
        bundling: {
          commandHooks: {
            afterBundling: (inputDir: string, outputDir: string): string[] => [
              `cp ${inputDir}/bundle.pem ${outputDir}`,
            ],
            beforeBundling: (
              _inputDir: string,
              _outputDir: string
            ): string[] => [],
            beforeInstall: (
              _inputDir: string,
              _outputDir: string
            ): string[] => [],
          },
        },
      }
    );

    if (workload === 'stage' && secret && rdsProxy) {
      secret.grantRead(userRecommendationHandler);
      rdsProxy.grantConnect(userRecommendationHandler);
    }

    userRecommendationHandler.addEventSource(
      new SqsEventSource(userUpdatedQueue, { batchSize: 1 })
    );

    const bookRecommendationProjectRoot = path.resolve(
      __dirname,
      '../lambdas/book-recommendation-handler'
    );

    const imagesBucket = Bucket.fromBucketName(
      this,
      `flock-images-${workload}`,
      workload === 'dev'
        ? 'flock-api-dev-flockimages95de63b1-6uuwx9hyb7gv'
        : `flock-images-${workload}`
    );

    const isbnDBKeySecret = Secret.fromSecretNameV2(
      this,
      'isbndb-key',
      'isbndb-key'
    );

    const bookRecommendationHandler = new NodejsFunction(
      this,
      `book-recommendation-handler-${workload}`,
      {
        functionName: `book-recommendation-handler-${workload}`,
        projectRoot: bookRecommendationProjectRoot,
        entry: path.join(bookRecommendationProjectRoot, 'function.ts'),
        depsLockFilePath: path.join(
          bookRecommendationProjectRoot,
          'package-lock.json'
        ),
        runtime: Runtime.NODEJS_20_X,
        vpc: workload === 'prod' ? props.vpc : undefined,
        vpcSubnets:
          workload === 'prod'
            ? {
                subnetType: SubnetType.PRIVATE_WITH_EGRESS,
              }
            : undefined,
        allowPublicSubnet: true,
        timeout: cdk.Duration.seconds(120),
        // securityGroups:
        //   workload === 'stage' && lambdaToRDSProxyGroup
        //     ? [lambdaToRDSProxyGroup]
        //     : undefined,
        environment: {
          DB_HOST: dbCredentials.host,
          DB_NAME: dbCredentials.name,
          DB_USER: dbCredentials.username,
          DB_PASS: dbCredentials.password,
          // RDS_SECRET_NAME: `rds-credentials-secret-${workload}`,
          OPEN_AI_ORGANIZATION: process.env.OPEN_AI_ORGANIZATION!,
          OPEN_AI_PROJECT: process.env.OPEN_AI_PROJECT!,
          OPEN_AI_API_KEY: process.env.OPEN_AI_API_KEY!,
          IMAGES_BUCKET: imagesBucket.bucketName,
          ISBNDB_API_URL: 'https://api2.isbndb.com',
          ISBNDB_API_KEY: isbnDBKeySecret.secretValue.unsafeUnwrap(),
        },
        bundling: {
          nodeModules: ['sharp'],
          forceDockerBundling: true,
          commandHooks: {
            afterBundling: (inputDir: string, outputDir: string): string[] => [
              `cp ${inputDir}/bundle.pem ${outputDir}`,
              `cp ${inputDir}/subjects.json ${outputDir}`,
            ],
            beforeBundling: (
              _inputDir: string,
              _outputDir: string
            ): string[] => [],
            beforeInstall: (
              _inputDir: string,
              _outputDir: string
            ): string[] => [],
          },
        },
      }
    );

    imagesBucket.grantWrite(bookRecommendationHandler);

    if (workload === 'stage' && secret && rdsProxy) {
      secret.grantRead(bookRecommendationHandler);
      rdsProxy.grantConnect(bookRecommendationHandler);
    }

    bookRecommendationHandler.addEventSource(
      new SqsEventSource(conversationCreatedQueue, { batchSize: 1 })
    );
  }
}

const getDBCredentials = (workload: string, secret: ISecret) => {
  return {
    host:
      workload === 'prod'
        ? secret!.secretValueFromJson('host').unsafeUnwrap()
        : 'flock-db-stage.cvi6m0giyhbg.us-east-1.rds.amazonaws.com',
    name: workload === 'dev' ? 'flock_db_dev' : 'flock_db',
    password:
      workload === 'prod'
        ? secret!.secretValueFromJson('password').unsafeUnwrap()
        : process.env.DB_PASS!,
    username:
      workload === 'prod'
        ? secret!.secretValueFromJson('username').unsafeUnwrap()
        : process.env.DB_USER!,
  };
};
