import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { join } from 'path';
import { CfnService } from 'aws-cdk-lib/aws-apprunner';
import { UserPool, UserPoolOperation } from 'aws-cdk-lib/aws-cognito';
import { Effect, Policy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { BlockPublicAccess, Bucket } from 'aws-cdk-lib/aws-s3';
import { ApiStackProps } from '../bin/flock-cdk';
import 'dotenv/config';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import 'dotenv/config';

export class FlockApiStack extends cdk.Stack {
  public readonly imagesBucket: Bucket;

  constructor(scope: Construct, id: string, props?: ApiStackProps) {
    super(scope, id, props);

    // Cognito (Users)

    const defineAuthChallengeFunction = new Function(
      this,
      `auth-trigger-define-challenge-${this.stackName}`,
      {
        runtime: Runtime.NODEJS_20_X,
        memorySize: 128,
        handler: 'function.handler',
        code: Code.fromAsset(
          join(__dirname, '../lambdas/auth-trigger-define-challenge')
        ),
      }
    );

    const createAuthChallengeFunction = new Function(
      this,
      `auth-trigger-create-challenge-${this.stackName}`,
      {
        runtime: Runtime.NODEJS_20_X,
        memorySize: 128,
        handler: 'function.handler',
        code: Code.fromAsset(
          join(__dirname, '../lambdas/auth-trigger-create-challenge')
        ),
      }
    );

    createAuthChallengeFunction.role?.attachInlinePolicy(
      new Policy(this, 'sms-policy', {
        statements: [
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ['sns:Publish'],
            resources: ['*'],
          }),
        ],
      })
    );

    const preSignUpFunction = new Function(
      this,
      `auth-trigger-pre-signup-${this.stackName}`,
      {
        runtime: Runtime.NODEJS_20_X,
        memorySize: 128,
        handler: 'function.handler',
        code: Code.fromAsset(
          join(__dirname, '../lambdas/auth-trigger-pre-signup')
        ),
      }
    );

    const verifyChallengeFunction = new Function(
      this,
      `auth-trigger-verify-challenge-${this.stackName}`,
      {
        runtime: Runtime.NODEJS_20_X,
        memorySize: 128,
        handler: 'function.handler',
        code: Code.fromAsset(
          join(__dirname, '../lambdas/auth-trigger-verify-challenge')
        ),
      }
    );

    const userPool = new UserPool(this, this.stackName, {
      userPoolName: this.stackName,
      selfSignUpEnabled: true,
      signInCaseSensitive: false,
      signInAliases: {
        phone: true,
      },
      autoVerify: {
        phone: true,
      },
      standardAttributes: {
        birthdate: {
          required: true,
        },
      },
    });

    userPool.addTrigger(
      UserPoolOperation.DEFINE_AUTH_CHALLENGE,
      defineAuthChallengeFunction
    );

    userPool.addTrigger(
      UserPoolOperation.CREATE_AUTH_CHALLENGE,
      createAuthChallengeFunction
    );

    userPool.addTrigger(UserPoolOperation.PRE_SIGN_UP, preSignUpFunction);

    userPool.addTrigger(
      UserPoolOperation.VERIFY_AUTH_CHALLENGE_RESPONSE,
      verifyChallengeFunction
    );

    const userPoolClient = userPool.addClient('flock-api', {
      generateSecret: true,
      authFlows: {
        adminUserPassword: true,
        custom: true,
      },
      accessTokenValidity: cdk.Duration.days(1),
      idTokenValidity: cdk.Duration.days(1),
      refreshTokenValidity: cdk.Duration.days(360),
    });

    // S3 Bucket (Images)

    this.imagesBucket = new Bucket(this, 'flock-images', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
    });

    const isbnDBKeySecret = Secret.fromSecretNameV2(
      this,
      'isbndb-key',
      'isbndb-key'
    );

    const appRunnerService = new CfnService(
      this,
      `${this.stackName}-apprunner-service`,
      {
        serviceName: this.stackName,
        sourceConfiguration: {
          autoDeploymentsEnabled: true,
          authenticationConfiguration: {
            connectionArn:
              'arn:aws:apprunner:us-east-1:431027017019:connection/CodigoDelSur/d365fb68f2c14a9cb12ca5f6cfb00d03',
          },
          codeRepository: {
            codeConfiguration: {
              configurationSource: 'API',
              codeConfigurationValues: {
                buildCommand: 'npm install',
                startCommand: 'npm start',
                port: '3000',
                runtime: 'NODEJS_18',
                runtimeEnvironmentSecrets: [
                  {
                    name: 'FIREBASE_PRIVATE_KEY',
                    value:
                      'arn:aws:ssm:us-east-1:431027017019:parameter/FIREBASE_PRIVATE_KEY_DEV',
                  },
                ],
                runtimeEnvironmentVariables: [
                  {
                    name: 'COGNITO_CLIENT_ID',
                    value: userPoolClient.userPoolClientId,
                  },
                  {
                    name: 'COGNITO_CLIENT_SECRET',
                    value: userPoolClient.userPoolClientSecret.unsafeUnwrap(),
                  },
                  {
                    name: 'COGNITO_USER_POOL_ID',
                    value: userPool.userPoolId,
                  },
                  {
                    name: 'DB_HOST',
                    value:
                      'flock-db-stage.cvi6m0giyhbg.us-east-1.rds.amazonaws.com',
                  },
                  { name: 'DB_LOGGING', value: 'false' },
                  { name: 'DB_NAME', value: 'flock_db_dev' }, // TODO - Don't harcode it
                  { name: 'DB_PASS', value: process.env.DB_PASS },
                  { name: 'DB_PORT', value: '5432' },
                  { name: 'DB_SSL', value: 'true' },
                  { name: 'DB_USER', value: process.env.DB_PASS },
                  {
                    name: 'IMAGES_BUCKET',
                    value: this.imagesBucket.bucketName,
                  },
                  {
                    name: 'OPEN_LIBRARY_COVERS_URL',
                    value: 'https://covers.openlibrary.org',
                  },
                  {
                    name: 'OPEN_LIBRARY_URL',
                    value: 'https://openlibrary.org',
                  },
                  {
                    name: 'UPDATE_PROFILE_TOPIC_ARN',
                    value: props!.userUpdatedTopic!.topicArn, // 'arn:aws:sns:us-east-1:431027017019:user-profile-updated-topic-dev',
                  },
                  {
                    name: 'CONVERSATION_CREATED_TOPIC_ARN',
                    value: props!.conversationCreatedTopic!.topicArn,
                  },
                  {
                    name: 'CREATE_BOOK_TOPIC_ARN', // TODO - Get from topic resource
                    value:
                      'arn:aws:sns:us-east-1:431027017019:book-created-topic-dev',
                  },
                  {
                    name: 'FIREBASE_AUTH_CERT_URL',
                    value: 'https://www.googleapis.com/oauth2/v1/certs',
                  },
                  {
                    name: 'FIREBASE_CLIENT_CERT_URL',
                    value:
                      'https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-l31uz%40flock-89274.iam.gserviceaccount.com',
                  },
                  {
                    name: 'FIREBASE_CLIENT_EMAIL',
                    value:
                      'firebase-adminsdk-l31uz@flock-89274.iam.gserviceaccount.com',
                  },
                  {
                    name: 'FIREBASE_CLIENT_ID',
                    value: '102778840894606863219',
                  },
                  {
                    name: 'FIREBASE_PRIVATE_KEY_ID',
                    value: 'aeafb95d5f0ddf29609ac661a0bf746e9b033bf9',
                  },
                  {
                    name: 'FIREBASE_PROJECT_ID',
                    value: 'flock-89274',
                  },
                  {
                    name: 'FIREBASE_TOKEN_URI',
                    value: 'https://oauth2.googleapis.com/token',
                  },
                  {
                    name: 'FIREBASE_TYPE',
                    value: 'service_account',
                  },
                  {
                    name: 'FIREBASE_UNIVERSAL_DOMAIN',
                    value: 'googleapis.com',
                  },
                  {
                    name: 'REGISTRATION_TOKEN_DURATION_IN_MONTHS',
                    value: '6',
                  },
                  { name: 'ISBNDB_URL', value: 'https://api2.isbndb.com' },
                  {
                    name: 'ISBNDB_API_KEY',
                    value: isbnDBKeySecret.secretValue.unsafeUnwrap(),
                  },
                  { name: 'REPORT_FROM_EMAIL', value: 'hello@onflock.com' },
                  {
                    name: 'REPORT_TO_EMAIL',
                    value: 'nverino@codigodelsur.com',
                  },
                ],
              },
            },
            repositoryUrl: 'https://github.com/codigodelsur/Flock-API',
            sourceCodeVersion: { type: 'BRANCH', value: 'dev' },
            sourceDirectory: '/',
          },
        },
        networkConfiguration: {
          egressConfiguration: {
            egressType: 'DEFAULT',
          },
          ingressConfiguration: {
            isPubliclyAccessible: true,
          },
          ipAddressType: 'IPV4',
        },
        instanceConfiguration: {
          instanceRoleArn:
            'arn:aws:iam::431027017019:role/apprunner-secrets-manager',
        },
        tags: [
          { key: 'Project', value: 'Flock' },
          { key: 'Module', value: 'API' },
          { key: 'Env', value: 'Dev' },
        ],
      }
    );
  }
}
