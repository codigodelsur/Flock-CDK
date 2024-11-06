import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Bucket, BucketAccessControl } from 'aws-cdk-lib/aws-s3';
import { Distribution, OriginAccessIdentity } from 'aws-cdk-lib/aws-cloudfront';
import { S3Origin } from 'aws-cdk-lib/aws-cloudfront-origins';

export class FlockWebStack extends cdk.Stack {
  constructor(scope: Construct, id: string, workload: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new Bucket(this, 'flock-web', {
      bucketName: `flock-web-${workload}`,
      accessControl: BucketAccessControl.PRIVATE,
    });

    const originAccessIdentity = new OriginAccessIdentity(
      this,
      'flock-web-origin-access-identity'
    );

    bucket.grantRead(originAccessIdentity);

    new Distribution(this, 'flock-web-distribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: new S3Origin(bucket, { originAccessIdentity }),
      },
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        }
      ]
    });
  }
}
