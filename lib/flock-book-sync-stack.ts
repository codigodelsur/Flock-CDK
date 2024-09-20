import { Duration, Stack, StackProps } from 'aws-cdk-lib';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import path = require('path');
import { SyncStackProps } from '../bin/flock-cdk';
import 'dotenv/config';

export class FlockBookSyncStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    workload: string,
    props: SyncStackProps
  ) {
    super(scope, id, props);

    const projectRoot = path.resolve(__dirname, '../lambdas/book-sync-handler');

    const handler = new NodejsFunction(this, `book-sync-handler-${workload}`, {
      functionName: `book-sync-handler-${workload}`,
      projectRoot,
      entry: path.join(projectRoot, 'function.ts'),
      depsLockFilePath: path.join(projectRoot, 'package-lock.json'),
      runtime: Runtime.NODEJS_20_X,
      allowPublicSubnet: true,
      timeout: Duration.seconds(120),
      securityGroups: [],
      environment: {
        DB_HOST: 'flock-db-stage.cvi6m0giyhbg.us-east-1.rds.amazonaws.com',
        DB_NAME: workload === 'dev' ? 'flock_db_dev' : 'flock_db',
        DB_USER: process.env.DB_USER,
        DB_PASS: process.env.DB_PASS,
        IMAGES_BUCKET: 'flock-api-dev-flockimages95de63b1-6uuwx9hyb7gv',
        NY_TIMES_API_URL: 'https://api.nytimes.com/svc/books/v3',
        NY_TIMES_API_KEY: process.env.NY_TIMES_API_KEY,
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
    });

    const rule = new Rule(this, `cron-${workload}`, {
      schedule: Schedule.expression('cron(0 6 ? * MON *)'),
      enabled: true,
    });

    rule.addTarget(new LambdaFunction(handler));

    props.imagesBucket.grantWrite(handler);
  }
}
