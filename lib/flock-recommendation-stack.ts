import * as cdk from 'aws-cdk-lib';
import { Port, SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { DatabaseInstance, DatabaseInstanceEngine } from 'aws-cdk-lib/aws-rds';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { SqsSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import path = require('path');

export class FlockRecommendationStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    workload: string,
    props?: cdk.StackProps
  ) {
    super(scope, id, props);

    // SNS Topic
    const topic = new Topic(this, 'user-profile-updated-topic', {
      displayName: 'Updated User Profile',
      topicName: `user-profile-updated-topic-${workload}`,
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
    const queue = new Queue(this, 'user-profile-updated-queue', {
      receiveMessageWaitTime: cdk.Duration.seconds(2),
      visibilityTimeout: cdk.Duration.seconds(120),
      // add dead-letter queue
    });

    topic.addSubscription(new SqsSubscription(queue));

    const projectRoot = path.resolve(
      __dirname,
      '../lambdas/user-recommendation-handler'
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

    const secret = new Secret(this, 'rds-credentials-secret', {
      secretName: `rds-credentials-secret-${workload}`,
      secretObjectValue: {
        username: new cdk.SecretValue('postgres'),
        password: new cdk.SecretValue('Sa6Mh4y9H9MQKxknPeggmdY'),
      },
    });

    const dbConnectionGroup = new SecurityGroup(
      this,
      'Proxy to DB Connection',
      {
        vpc,
      }
    );

    const lambdaToRDSProxyGroup = new SecurityGroup(
      this,
      'Lambda to RDS Proxy Connection',
      {
        vpc,
      }
    );

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

    const rdsProxy = rdsInstance.addProxy(`${id}-proxy`, {
      vpc,
      secrets: [secret],
      securityGroups: [dbConnectionGroup],
      requireTLS: true,
    });

    // Lambda
    const handler = new NodejsFunction(
      this,
      `user-recommendation-handler-${workload}`,
      {
        projectRoot,
        entry: path.join(projectRoot, 'function.ts'),
        depsLockFilePath: path.join(projectRoot, 'package-lock.json'),
        runtime: Runtime.NODEJS_20_X,
        vpc,
        allowPublicSubnet: true,
        timeout: cdk.Duration.seconds(60),
        securityGroups: [lambdaToRDSProxyGroup],
        environment: {
          DB_HOST: rdsProxy.endpoint,
          RDS_SECRET_NAME: `rds-credentials-secret-${workload}`,
          DB_NAME: workload === 'dev' ? 'flock_db_dev' : 'flock_db',
          DB_USER: 'postgres',
          DB_PASS: 'Sa6Mh4y9H9MQKxknPeggmdY',
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

    secret.grantRead(handler);

    rdsProxy.grantConnect(handler);

    handler.addEventSource(new SqsEventSource(queue, { batchSize: 1 }));
  }
}
