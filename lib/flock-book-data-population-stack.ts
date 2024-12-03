import * as cdk from 'aws-cdk-lib';
import { Port, SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { DatabaseProxy } from 'aws-cdk-lib/aws-rds';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { SqsSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import path = require('path');
import { BookDataPopulationStackProps } from '../bin/flock-cdk';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import 'dotenv/config';

export class FlockBookDataPopulationStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    workload: string,
    props: BookDataPopulationStackProps
  ) {
    super(scope, id, props);

    let imagesBucket;

    if (!props.imagesBucket) {
      imagesBucket = Bucket.fromBucketName(
        this,
        'flock-images-stage',
        'flock-images-stage'
      );
    } else {
      imagesBucket = props.imagesBucket;
    }

    // SNS Topic
    const topic = new Topic(this, 'book-created-topic', {
      displayName: 'Created Book',
      topicName: `book-created-topic-${workload}`,
      // loggingConfigs: [
      //   {
      //     protocol: LoggingProtocol.SQS,
      //     failureFeedbackRole: role,
      //     successFeedbackRole: role,
      //     successFeedbackSampleRate: 50,
      //   },
      // ],
    });

    // SQS Queue
    const queue = new Queue(this, 'book-created-queue', {
      receiveMessageWaitTime: cdk.Duration.seconds(2),
      visibilityTimeout: cdk.Duration.seconds(120),
      // add dead-letter queue
    });

    topic.addSubscription(new SqsSubscription(queue));

    // const vpc = Vpc.fromLookup(this, 'vpc', { isDefault: true });

    // const secret = Secret.fromSecretCompleteArn(
    //   this,
    //   'rds-credentials-secret',
    //   workload === 'dev'
    //     ? 'arn:aws:secretsmanager:us-east-1:431027017019:secret:rds-credentials-secret-dev-FGVNuH'
    //     : 'arn:aws:secretsmanager:us-east-1:431027017019:secret:rds-credentials-secret-stage-vE757P'
    // );

    const isbnDBKeySecret = Secret.fromSecretCompleteArn(
      this,
      'isbndb-key',
      'arn:aws:secretsmanager:us-east-1:431027017019:secret:isbndb-key-PeG1jN'
    );

    // const dbConnectionGroup = new SecurityGroup(
    //   this,
    //   'Proxy to DB Connection',
    //   {
    //     vpc,
    //   }
    // );

    // const lambdaToRDSProxyGroup = new SecurityGroup(
    //   this,
    //   'Lambda to RDS Proxy Connection',
    //   {
    //     vpc,
    //   }
    // );

    // dbConnectionGroup.addIngressRule(
    //   dbConnectionGroup,
    //   Port.tcp(5432),
    //   'allow db connection'
    // );

    // dbConnectionGroup.addIngressRule(
    //   lambdaToRDSProxyGroup,
    //   Port.tcp(5432),
    //   'allow lambda connection'
    // );

    // const rdsProxySecurityGroup = SecurityGroup.fromSecurityGroupId(
    //   this,
    //   'rds-proxy-security-group',
    //   'sg-0d271b01a09f02186'
    // );

    // const rdsProxy = DatabaseProxy.fromDatabaseProxyAttributes(
    //   this,
    //   'rds-proxy',
    //   {
    //     dbProxyArn:
    //       workload === 'dev'
    //         ? 'arn:aws:rds:us-east-1:431027017019:db-proxy:prx-098e7cbe539feeb4c'
    //         : 'arn:aws:rds:us-east-1:431027017019:db-proxy:prx-0490b9cb27558804a',
    //     dbProxyName:
    //       workload === 'dev'
    //         ? 'flockrecommendationdevrdsfecommendationstackdevproxy984ca9dc'
    //         : 'flockrecommendationstackstommendationstackstageproxy35d5e20f',
    //     endpoint:
    //       workload === 'dev'
    //         ? 'flockrecommendationdevrdsfecommendationstackdevproxy984ca9dc.proxy-cvi6m0giyhbg.us-east-1.rds.amazonaws.com'
    //         : 'flockrecommendationstackstommendationstackstageproxy35d5e20f.proxy-cvi6m0giyhbg.us-east-1.rds.amazonaws.com',
    //     securityGroups: [rdsProxySecurityGroup],
    //   }
    // );

    // rdsProxySecurityGroup.addIngressRule(
    //   lambdaToRDSProxyGroup,
    //   Port.tcp(5432),
    //   'allow lambda connection'
    // );

    const projectRoot = path.resolve(
      __dirname,
      '../lambdas/book-data-population-handler'
    );

    // Lambda
    const handler = new NodejsFunction(
      this,
      `book-data-population-handler-${workload}`,
      {
        functionName: `book-data-population-handler-${workload}`,
        projectRoot,
        entry: path.join(projectRoot, 'function.ts'),
        depsLockFilePath: path.join(projectRoot, 'package-lock.json'),
        runtime: Runtime.NODEJS_20_X,
        // vpc,
        allowPublicSubnet: true,
        timeout: cdk.Duration.seconds(60),
        // securityGroups: [lambdaToRDSProxyGroup],
        environment: {
          DB_HOST: 'flock-db-stage.cvi6m0giyhbg.us-east-1.rds.amazonaws.com', // rdsProxy.endpoint,
          RDS_SECRET_NAME: `rds-credentials-secret-${workload}`,
          DB_NAME: workload === 'dev' ? 'flock_db_dev' : 'flock_db',
          DB_USER: process.env.DB_USER!,
          DB_PASS: process.env.DB_PASS!,
          IMAGES_BUCKET: imagesBucket.bucketName,
          ISBNDB_API_URL: 'https://api2.isbndb.com',
          ISBNDB_API_KEY: isbnDBKeySecret.secretValue.unsafeUnwrap(),
        },
        bundling: {
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

    // secret.grantRead(handler);

    // rdsProxy.grantConnect(handler, 'postgres');

    imagesBucket.grantWrite(handler);
    handler.addEventSource(new SqsEventSource(queue, { batchSize: 1 }));
  }
}
