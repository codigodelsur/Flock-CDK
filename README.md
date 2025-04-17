# Welcome to Flock-CDK

CDK development with TypeScript

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Stacks

### FlockWeb Stack

Stack for the Landing Page

#### Services

- S3 Bucket
- CloudFront Distribution

```bash
npx cdk deploy FlockWebStack
```

### FlockApi Stack

Stack for the API

#### Services

- Cognito
- Lambda
- AppRunner

```bash
npx cdk deploy FlockApiStack-<Env>
```

### Recommendation Stack

Stack for the Recommendation Engine

#### Services

- SNS topic
- SQS queue
- Lambda

```bash
npx cdk deploy FlockRecommendationStack-<Env>
```

### Book Data Population Stack

Stack for the Books Data Population. When we add a book to our database, we set just initial data, we have to add more
details to each book in a parallel service.

#### Services

- SNS topic
- SQS queue
- Lambda

```bash
npx cdk deploy FlockBookDataPopulationStack-<Env>
```

### Book Sync Stack

Stack for the Book Sync service, which retrieves data from NY Times Best Seller API, to add new books to our database.

#### Services

- SNS topic
- SQS queue
- Lambda

```bash
npx cdk deploy FlockBookSyncStack-<Env>
```

### Notifications Stack

Stack for recurring Push Notifications creation

#### Services

- SNS topic
- SQS queue
- Lambda

```bash
npx cdk deploy FlockNotificationsStack-<Env>
```

### Book Refreshing Stack

Stack for new covers downloading

#### Services

- SNS topic
- SQS queue
- Lambda

```bash
npx cdk deploy FlockBookRefreshingStack-<Env>
```

## Create CDKToolkit

```bash
npm run bootstrap
```

## Useful commands

- `npm run build` compile typescript to js
- `npm run watch` watch for changes and compile
- `npm run test` perform the jest unit tests
- `npx cdk deploy` deploy this stack to your default AWS account/region
- `npx cdk deploy --hotswap` deploy just what changed
- `npx cdk deploy [StackName]` deploy a specific stack
- `npx cdk diff` compare deployed stack with current state
- `npx cdk synth` emits the synthesized CloudFormation template
