import { Duration, Stack } from 'aws-cdk-lib';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import path = require('path');
import { NotificationsStackProps } from '../bin/flock-cdk';
import 'dotenv/config';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import 'dotenv/config';
import { SubnetType } from 'aws-cdk-lib/aws-ec2';
import { getDBCredentials } from './db';

export class FlockNotificationsStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    workload: string,
    props: NotificationsStackProps
  ) {
    super(scope, id, props);

    const projectRoot = path.resolve(
      __dirname,
      '../lambdas/notifications-handler'
    );

    const dbCredentials = getDBCredentials(workload, props.masterUserSecret!);

    const handler = new NodejsFunction(
      this,
      `notifications-handler-${workload}`,
      {
        functionName: `notifications-handler-${workload}`,
        projectRoot,
        entry: path.join(projectRoot, 'function.ts'),
        depsLockFilePath: path.join(projectRoot, 'package-lock.json'),
        runtime: Runtime.NODEJS_20_X,
        allowPublicSubnet: true,
        timeout: Duration.seconds(240),
        memorySize: 128,
        vpcSubnets:
          workload === 'prod'
            ? {
                subnetType: SubnetType.PRIVATE_WITH_EGRESS,
              }
            : undefined,
        vpc: workload === 'prod' ? props.vpc : undefined,
        environment: {
          DB_HOST: dbCredentials.host,
          DB_NAME: dbCredentials.name,
          DB_USER: dbCredentials.username,
          DB_PASS: dbCredentials.password,
          FIREBASE_TYPE: process.env.FIREBASE_TYPE!,
          FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID!,
          FIREBASE_PRIVATE_KEY_ID: process.env.FIREBASE_PRIVATE_KEY_ID!,
          FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY!,
          FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL!,
          FIREBASE_CLIENT_ID: process.env.FIREBASE_CLIENT_ID!,
          FIREBASE_AUTH_URI: process.env.FIREBASE_AUTH_URI!,
          FIREBASE_TOKEN_URI: process.env.FIREBASE_TOKEN_URI!,
          FIREBASE_AUTH_CERT_URL: process.env.FIREBASE_AUTH_CERT_URL!,
          FIREBASE_CLIENT_CERT_URL: process.env.FIREBASE_CLIENT_CERT_URL!,
          FIREBASE_UNIVERSAL_DOMAIN: process.env.FIREBASE_UNIVERSAL_DOMAIN!,
        },
        bundling: {
          nodeModules: ['sharp'],
          forceDockerBundling: true,
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

    const rule = new Rule(this, `cron-${workload}`, {
      schedule: Schedule.expression('cron(0 12 ? * MON *)'),
      enabled: true,
    });

    rule.addTarget(new LambdaFunction(handler));
  }
}
