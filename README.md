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

- AppRunner
- Lambda

```bash
npx cdk deploy FlockApiStack
```

### FlockRecommendation

Stack for the Recommendation Engine

#### Services

- SNS topic
- SQS queue
- Lambda

```bash
npx cdk deploy FlockRecommendationStack-Stage
```

### FlockRecommendation

Stack for the Recommendation Engine

#### Services

- SNS topic
- SQS queue
- Lambda

```bash
npx cdk deploy FlockBookDataPopulationStack-Dev
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

