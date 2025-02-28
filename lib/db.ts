import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';

export const getDBCredentials = (workload: string, secret: ISecret) => {
  return {
    host:
      workload === 'prod'
        ? secret!.secretValueFromJson('host').unsafeUnwrap()
        : 'flock-db-stage.cvi6m0giyhbg.us-east-1.rds.amazonaws.com',
    name: workload === 'dev' ? 'flock_db_dev' : 'flock_db',
    password:
      workload === 'prod'
        ? secret!.secretValueFromJson('password').unsafeUnwrap()
        : process.env.DB_PASS!,
    username:
      workload === 'prod'
        ? secret!.secretValueFromJson('username').unsafeUnwrap()
        : process.env.DB_USER!,
  };
};
