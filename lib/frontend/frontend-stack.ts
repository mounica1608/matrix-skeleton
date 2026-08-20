import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export interface FrontendStackProps extends cdk.StackProps {
  projectName: string;
  ssmParameterPrefix: string;
  environment: string;
  domainName: string;
  certificate: acm.ICertificate;
  artifactBucket: s3.IBucket;
  alarmTopic: sns.ITopic;
  githubConnection: string;
  githubRepo: string;
  githubBranch: string;
  buildEnvVars: string[];
}

export class FrontendStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;
  public readonly siteBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    const stackName = `${props.projectName}-frontend-${props.environment}`;
    const ssmParameterPrefix = props.ssmParameterPrefix;

    // S3 bucket to hold the built static site (private, served only via CloudFront OAC)
    this.siteBucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: `${stackName}-site-${cdk.Stack.of(this).account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    // CloudFront distribution (SPA routing: 403/404 -> index.html so client-side routes resolve)
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      domainNames: [props.domainName],
      certificate: props.certificate,
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    // IAM: CodeBuild role
    const codeBuildRole = new iam.Role(this, 'CodeBuildRole', {
      roleName: `${stackName}-codebuild-role`,
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    });

    codeBuildRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        resources: [
          `arn:aws:logs:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:log-group:/aws/codebuild/${stackName}*`,
        ],
      })
    );

    codeBuildRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameters', 'ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter/${ssmParameterPrefix}/*`,
        ],
      })
    );

    codeBuildRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudfront:CreateInvalidation'],
        resources: [
          `arn:aws:cloudfront::${cdk.Stack.of(this).account}:distribution/${this.distribution.distributionId}`,
        ],
      })
    );

    this.siteBucket.grantReadWrite(codeBuildRole);

    // Buildspec: fetch VITE_* values from SSM, build the Vite app, sync to S3, invalidate CloudFront
    const exportCommands = props.buildEnvVars.map(
      (envVar) =>
        `export ${envVar}=$(aws ssm get-parameter --name "/${ssmParameterPrefix}/${envVar}" --with-decryption --query Parameter.Value --output text)`
    );

    const buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
      projectName: `${stackName}-build`,
      role: codeBuildRole,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': { nodejs: 20 },
          },
          pre_build: {
            commands: ['npm ci', ...exportCommands],
          },
          build: {
            commands: ['npm run build'],
          },
          post_build: {
            commands: [
              `aws s3 sync dist/ s3://${this.siteBucket.bucketName} --delete`,
              `aws cloudfront create-invalidation --distribution-id ${this.distribution.distributionId} --paths "/*"`,
            ],
          },
        },
        artifacts: {
          'base-directory': 'dist',
          files: ['**/*'],
        },
      }),
    });

    // CodePipeline: Source (existing CodeConnections) -> Build -> (deploy happens inside buildspec)
    const sourceOutput = new codepipeline.Artifact('SourceOutput');
    const buildOutput = new codepipeline.Artifact('BuildOutput');

    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: `${stackName}-pipeline`,
      artifactBucket: props.artifactBucket,
      restartExecutionOnUpdate: true,
    });

    pipeline.addStage({
      stageName: 'Source',
      actions: [
        new codepipeline_actions.CodeStarConnectionsSourceAction({
          actionName: 'GitHub_Source',
          owner: props.githubRepo.split('/')[0],
          repo: props.githubRepo.split('/')[1],
          branch: props.githubBranch,
          connectionArn: props.githubConnection,
          output: sourceOutput,
        }),
      ],
    });

    pipeline.addStage({
      stageName: 'Build',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'Build_And_Deploy',
          project: buildProject,
          input: sourceOutput,
          outputs: [buildOutput],
        }),
      ],
    });

    // CloudWatch Alarm: pipeline failures
    const pipelineFailureMetric = new cloudwatch.Metric({
      namespace: 'AWS/CodePipeline',
      metricName: 'PipelineExecutionFailure',
      dimensionsMap: {
        PipelineName: pipeline.pipelineName,
      },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const pipelineFailureAlarm = new cloudwatch.Alarm(this, 'PipelineFailureAlarm', {
      alarmName: `${stackName}-pipeline-failure`,
      metric: pipelineFailureMetric,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      actionsEnabled: true,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    pipelineFailureAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(props.alarmTopic));

    // Outputs
    new cdk.CfnOutput(this, 'SiteBucketName', {
      value: this.siteBucket.bucketName,
      description: 'S3 bucket holding the built frontend',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront distribution ID',
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'CloudFront distribution domain name',
    });

    new cdk.CfnOutput(this, 'SiteUrl', {
      value: `https://${props.domainName}`,
      description: 'Frontend site URL',
    });

    // Tag all resources
    cdk.Tags.of(this).add('Project', props.projectName);
    cdk.Tags.of(this).add('Environment', props.environment);
    cdk.Tags.of(this).add('Stack', stackName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
  }
}
