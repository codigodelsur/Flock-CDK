import { Duration, Stack } from 'aws-cdk-lib';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import path = require('path');
import { BookRefreshingStackProps } from '../bin/flock-cdk';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import 'dotenv/config';
import { ISecret, Secret } from 'aws-cdk-lib/aws-secretsmanager';
import 'dotenv/config';
import { SubnetType } from 'aws-cdk-lib/aws-ec2';
import { getDBCredentials } from './db';

export class FlockBookRefreshingStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    workload: string,
    props: BookRefreshingStackProps
  ) {
    super(scope, id, props);

    const projectRoot = path.resolve(
      __dirname,
      '../lambdas/book-refreshing-handler'
    );

    const dbCredentials = getDBCredentials(workload, props.masterUserSecret!);

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

    const isbnDBKeySecret = Secret.fromSecretNameV2(
      this,
      'isbndb-key',
      'isbndb-key'
    );

    const handler = new NodejsFunction(
      this,
      `book-refreshing-handler-${workload}`,
      {
        functionName: `book-refreshing-handler-${workload}`,
        projectRoot,
        entry: path.join(projectRoot, 'function.ts'),
        depsLockFilePath: path.join(projectRoot, 'package-lock.json'),
        runtime: Runtime.NODEJS_20_X,
        allowPublicSubnet: true,
        timeout: Duration.seconds(240),
        memorySize: 256,
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
      schedule: Schedule.expression('cron(0 6 ? * SUN *)'),
      enabled: true,
    });

    rule.addTarget(new LambdaFunction(handler));

    imagesBucket.grantWrite(handler);
  }
}
