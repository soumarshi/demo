import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

export class LambdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const fn = new NodejsFunction(this, 'HelloLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../src/handler.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: {
        STAGE: this.node.tryGetContext('stage') ?? 'dev',
      },
      logRetention: RetentionDays.ONE_WEEK,
    });

    new cdk.CfnOutput(this, 'LambdaName', { value: fn.functionName });
    new cdk.CfnOutput(this, 'LambdaArn', { value: fn.functionArn });
  }
}
