import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { join } from 'path';
import { CfnService, CfnVpcConnector } from 'aws-cdk-lib/aws-apprunner';
import { UserPool, UserPoolOperation } from 'aws-cdk-lib/aws-cognito';
import {
  Effect,
  Policy,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { BlockPublicAccess, Bucket } from 'aws-cdk-lib/aws-s3';
import { ApiStackProps } from '../bin/flock-cdk';
import 'dotenv/config';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import 'dotenv/config';
import {
  Credentials,
  DatabaseInstance,
  DatabaseInstanceEngine,
  PostgresEngineVersion,
  StorageType,
} from 'aws-cdk-lib/aws-rds';
import {
  InstanceClass,
  InstanceSize,
  InstanceType,
  IpAddresses,
  NatProvider,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { Topic } from 'aws-cdk-lib/aws-sns';

export class FlockApiStack extends cdk.Stack {
  public readonly imagesBucket: Bucket;
  public readonly masterUserSecret?: Secret;
  public readonly vpc?: Vpc;
  public readonly userUpdatedTopic: Topic;
  public readonly conversationCreatedTopic: Topic;
  public readonly bookCreatedTopic: Topic;

  constructor(
    scope: Construct,
    id: string,
    workload: string,
    props?: ApiStackProps
  ) {
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

    const instanceRole = new Role(this, 'apprunner-instance-role', {
      roleName: `apprunner-instance-role-${workload}`,
      assumedBy: new ServicePrincipal('tasks.apprunner.amazonaws.com'),
    });

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

    instanceRole.addToPolicy(
      new PolicyStatement({
        resources: [userPool.userPoolArn],
        actions: ['cognito-idp:AdminDeleteUser'],
        effect: Effect.ALLOW,
      })
    );

    // S3 Bucket (Images)

    this.imagesBucket = new Bucket(this, 'flock-images', {
      bucketName: `flock-images-${workload}`,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
    });

    this.imagesBucket.grantReadWrite(instanceRole);

    this.userUpdatedTopic = new Topic(this, 'user-profile-updated-topic', {
      displayName: 'Updated User Profile',
      topicName: `user-profile-updated-topic-${workload}`,
    });

    this.conversationCreatedTopic = new Topic(
      this,
      'conversation-created-topic',
      {
        displayName: 'Conversation Created',
        topicName: `conversation-created-topic-${workload}`,
      }
    );

    this.bookCreatedTopic = new Topic(this, 'book-created-topic', {
      displayName: 'Created Book',
      topicName: `book-created-topic-${workload}`,
    });

    this.userUpdatedTopic.grantPublish(instanceRole);
    this.conversationCreatedTopic.grantPublish(instanceRole);
    this.bookCreatedTopic.grantPublish(instanceRole);

    const isbnDBKeySecret = Secret.fromSecretNameV2(
      this,
      'isbndb-key',
      'isbndb-key'
    );

    const openAIKeySecret = Secret.fromSecretNameV2(
      this,
      'openai-key',
      'openai-key'
    );

    let vpcConnector;
    let dbInstance;

    if (workload === 'prod') {
      this.vpc = new Vpc(this, 'flock-vpc-prod', {
        ipAddresses: IpAddresses.cidr('10.0.0.0/16'),
        natGateways: 1,
        subnetConfiguration: [
          { name: 'ingress', subnetType: SubnetType.PUBLIC },
          { name: 'rds', subnetType: SubnetType.PRIVATE_WITH_EGRESS },
        ],
      });

      this.masterUserSecret = new Secret(this, 'db-master-user-secret', {
        secretName: 'db-master-user-secret-prod',
        description: 'Database master user credentials',
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ username: 'postgres' }),
          generateStringKey: 'password',
          passwordLength: 16,
          excludePunctuation: true,
        },
      });

      const dbSecurityGroup = new SecurityGroup(this, 'flock-db-sg-prod', {
        vpc: this.vpc,
        allowAllOutbound: true,
        description: 'Ingress for Postgres Server',
      });

      dbSecurityGroup.addIngressRule(
        Peer.ipv4(this.vpc.vpcCidrBlock),
        Port.tcp(5432)
      );

      dbInstance = new DatabaseInstance(this, 'flock-db', {
        vpc: this.vpc,
        instanceIdentifier: 'flock-db-prod',
        vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
        instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MICRO),
        engine: DatabaseInstanceEngine.postgres({
          version: PostgresEngineVersion.VER_16_3,
        }),
        port: 5432,
        databaseName: 'flock_db',
        credentials: Credentials.fromSecret(this.masterUserSecret),
        securityGroups: [dbSecurityGroup],
        multiAz: true,
        storageType: StorageType.GP3,
        storageEncrypted: true,
        enablePerformanceInsights: true,
      });

      vpcConnector = new CfnVpcConnector(this, 'vpc-connector', {
        subnets: this.vpc.selectSubnets({
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        }).subnetIds,
        securityGroups: [dbSecurityGroup.securityGroupId],
        vpcConnectorName: 'flock-vpc-prod-connector',
        tags: [
          {
            key: 'Project',
            value: 'Flock',
          },
          {
            key: 'Env',
            value: workload === 'prod' ? 'Prod' : 'Dev',
          },
        ],
      });
    }

    instanceRole.addToPolicy(
      new PolicyStatement({
        resources: ['*'],
        actions: ['ssm:Getparameters'],
      })
    );

    instanceRole.addToPolicy(
      new PolicyStatement({
        resources: ['*'],
        actions: ['ses:SendRawEmail'],
        effect: Effect.ALLOW,
      })
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
                      workload === 'prod'
                        ? 'arn:aws:ssm:us-east-1:431027017019:parameter/FIREBASE_PRIVATE_KEY_PROD'
                        : 'arn:aws:ssm:us-east-1:431027017019:parameter/FIREBASE_PRIVATE_KEY_DEV',
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
                      workload === 'prod'
                        ? dbInstance!.dbInstanceEndpointAddress
                        : 'flock-db-stage.cvi6m0giyhbg.us-east-1.rds.amazonaws.com',
                  },
                  { name: 'DB_LOGGING', value: 'false' },
                  {
                    name: 'DB_NAME',
                    value: workload === 'prod' ? 'flock_db' : 'flock_db_dev',
                  }, // TODO - Don't harcode it
                  {
                    name: 'DB_PORT',
                    value:
                      workload === 'prod'
                        ? dbInstance?.dbInstanceEndpointPort
                        : '5432',
                  },
                  { name: 'DB_SSL', value: 'true' },
                  {
                    name: 'DB_USER',
                    value:
                      workload === 'prod'
                        ? Credentials.fromSecret(this.masterUserSecret!)
                            .username
                        : process.env.DB_USER,
                  },
                  {
                    name: 'DB_PASS',
                    value:
                      workload === 'prod'
                        ? Credentials.fromSecret(
                            this.masterUserSecret!
                          ).password?.unsafeUnwrap()
                        : process.env.DB_PASS,
                  },
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
                    value: this.userUpdatedTopic.topicArn,
                  },
                  {
                    name: 'CONVERSATION_CREATED_TOPIC_ARN',
                    value: this.conversationCreatedTopic.topicArn,
                  },
                  {
                    name: 'CREATE_BOOK_TOPIC_ARN',
                    value: this.bookCreatedTopic.topicArn,
                  },
                  {
                    name: 'FIREBASE_AUTH_CERT_URL',
                    value: 'https://www.googleapis.com/oauth2/v1/certs',
                  },
                  {
                    name: 'FIREBASE_CLIENT_CERT_URL',
                    value:
                      workload === 'prod'
                        ? ''
                        : 'https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-l31uz%40flock-89274.iam.gserviceaccount.com',
                  },
                  {
                    name: 'FIREBASE_CLIENT_EMAIL',
                    value:
                      workload === 'prod'
                        ? 'firebase-adminsdk-fbsvc@flock-prod-4f34f.iam.gserviceaccount.com'
                        : 'firebase-adminsdk-l31uz@flock-89274.iam.gserviceaccount.com',
                  },
                  {
                    name: 'FIREBASE_AUTH_URI',
                    value: 'https://accounts.google.com/o/oauth2/auth',
                  },
                  {
                    name: 'FIREBASE_CLIENT_ID',
                    value:
                      workload === 'prod'
                        ? '113692911666788841685'
                        : '102778840894606863219',
                  },
                  {
                    name: 'FIREBASE_PRIVATE_KEY_ID',
                    value:
                      workload === 'prod'
                        ? '49663c7f60bc950d72b1252fd98f54a84331ecf3'
                        : 'aeafb95d5f0ddf29609ac661a0bf746e9b033bf9',
                  },
                  {
                    name: 'FIREBASE_PROJECT_ID',
                    value:
                      workload === 'prod' ? 'flock-prod-4f34f' : 'flock-89274',
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
                  { name: 'ISBNDB_API_URL', value: 'https://api2.isbndb.com' },
                  { name: 'ISBNDB_URL', value: 'https://api2.isbndb.com' },
                  {
                    name: 'ISBNDB_API_KEY',
                    value: isbnDBKeySecret.secretValue.unsafeUnwrap(),
                  },
                  {
                    name: 'OPEN_AI_ORGANIZATION',
                    value: 'org-1sgMYC3QFHlesU0z6YQDVEFB',
                  },
                  {
                    name: 'OPEN_AI_PROJECT',
                    value: 'proj_1O1YdxqpOcdC4MTtgJpYVKai',
                  },
                  {
                    name: 'OPEN_AI_API_KEY',
                    value: openAIKeySecret.secretValue.unsafeUnwrap(),
                  },

                  { name: 'REPORT_FROM_EMAIL', value: 'hello@onflock.com' },
                  {
                    name: 'REPORT_TO_EMAIL',
                    value: 'nverino@codigodelsur.com',
                  },
                  {
                    name: 'FLOCK_API_URL',
                    value:
                      workload === 'prod'
                        ? 'https://ikkykmvu3u.us-east-1.awsapprunner.com'
                        : 'https://znedfeu9be.us-east-1.awsapprunner.com',
                  },
                ],
              },
            },
            repositoryUrl: 'https://github.com/codigodelsur/Flock-API',
            sourceCodeVersion: {
              type: 'BRANCH',
              value: workload === 'prod' ? 'main' : 'dev',
            },
            sourceDirectory: '/',
          },
        },
        networkConfiguration: {
          egressConfiguration: {
            egressType: 'VPC',
            vpcConnectorArn: vpcConnector
              ? vpcConnector.attrVpcConnectorArn
              : undefined,
          },
          ingressConfiguration: {
            isPubliclyAccessible: true,
          },
          ipAddressType: 'IPV4',
        },
        instanceConfiguration: {
          cpu: '2048',
          memory: '4096',
          instanceRoleArn:
            workload === 'prod'
              ? instanceRole.roleArn
              : 'arn:aws:iam::431027017019:role/apprunner-secrets-manager',
        },
        tags: [
          { key: 'Project', value: 'Flock' },
          { key: 'Module', value: 'API' },
          { key: 'Env', value: workload === 'prod' ? 'Prod' : 'Dev' },
        ],
      }
    );
  }
}
