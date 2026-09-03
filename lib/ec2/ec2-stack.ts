import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53_targets from 'aws-cdk-lib/aws-route53-targets';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as events_targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';

export interface Ec2StackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  projectName: string;
  environment: string;
  ssmEnvironment?: string;
  ecrRepository: ecr.IRepository;
  artifactBucket: s3.IBucket;
  requiredEnvVars: string[];
  hostedZoneId: string;
  hostedZoneName: string;
  domainName: string;
  alarmTopic: sns.ITopic;
  githubConnection: string;
  githubRepo: string;
  githubBranch: string;
  loggingConfig: {
    retentionDays: number;
  };
  instanceType?: string;
  nightlyShutdown?: {
    enabled: boolean;
    // Cron expressions are UTC. Values here are examples for 1am/6am IST.
    shutdownCron: string;
    startupCron: string;
  };
}

export class Ec2Stack extends cdk.Stack {
  public readonly instance: ec2.Instance;
  public readonly eip: ec2.CfnEIP;
  public readonly codeDeployApplication: codedeploy.ServerApplication;
  public readonly codeDeployDeploymentGroup: codedeploy.ServerDeploymentGroup;

  constructor(scope: Construct, id: string, props: Ec2StackProps) {
    super(scope, id, props);

    const stackName = `${props.projectName}-${props.environment}-ec2`;
    const ssmParameterPrefix = `${props.projectName}/${props.ssmEnvironment || props.environment}`;

    // Security group: 80/443 from anywhere (Caddy handles TLS + ACME
    // challenge), SSH is NOT opened — use SSM Session Manager instead.
    const securityGroup = new ec2.SecurityGroup(this, 'InstanceSecurityGroup', {
      vpc: props.vpc,
      description: `Security group for ${stackName} EC2 instance`,
      allowAllOutbound: true,
    });
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'HTTP (ACME challenge + redirect to HTTPS)'
    );
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS'
    );

    // IAM: instance role (SSM Session Manager, pull SSM params, pull ECR
    // images, CodeDeploy agent permissions).
    const instanceRole = new iam.Role(this, 'InstanceRole', {
      roleName: `${stackName}-instance-role`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        // GetParametersByPath is what the CodeDeploy BeforeInstall hook
        // uses to bulk-regenerate .env on every deploy (picks up newly
        // added vars automatically); GetParameters/GetParameter are what
        // user-data.sh uses at initial boot.
        //
        // IAM resource matching is literal-string wildcard matching, not
        // path-prefix aware: "parameter/casemaster/dev/*" does NOT match
        // the bare "parameter/casemaster/dev" ARN that GetParametersByPath
        // checks when called with --path "/casemaster/dev" (no trailing
        // slash) — the wildcard requires the literal "dev/" substring to
        // already be present. Both the exact path and the wildcard are
        // needed: the former for the --path argument itself, the latter
        // for the individual parameters nested under it.
        actions: ['ssm:GetParameters', 'ssm:GetParameter', 'ssm:GetParametersByPath'],
        resources: [
          `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter/${ssmParameterPrefix}`,
          `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter/${ssmParameterPrefix}/*`,
        ],
      })
    );

    props.ecrRepository.grantPull(instanceRole);

    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      })
    );

    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['sns:Publish'],
        resources: [props.alarmTopic.topicArn],
      })
    );

    // S3 read access for the CodeDeploy agent to fetch deployment
    // bundles/revisions from the CodeDeploy-managed bucket.
    instanceRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2RoleforAWSCodeDeploy')
    );

    // Elastic IP: stable address across instance stop/start and
    // redeploys, so DNS doesn't need to change on every restart.
    this.eip = new ec2.CfnEIP(this, 'InstanceEip', {
      domain: 'vpc',
      tags: [{ key: 'Name', value: `${stackName}-eip` }],
    });

    const userDataScript = fs.readFileSync(
      path.join(__dirname, 'assets', 'user-data.sh'),
      'utf-8'
    );
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      userDataScript
        .replace(/__SSM_PREFIX__/g, ssmParameterPrefix)
        .replace(/__DOMAIN__/g, props.domainName)
        .replace(/__ECR_URI__/g, props.ecrRepository.repositoryUri)
        .replace(/__ENVIRONMENT__/g, props.environment)
        .replace(/__ALARM_TOPIC_ARN__/g, props.alarmTopic.topicArn)
        .replace(/__REGION__/g, cdk.Stack.of(this).region)
        .replace(/__REQUIRED_ENV_VARS__/g, props.requiredEnvVars.join(','))
    );

    this.instance = new ec2.Instance(this, 'Instance', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: new ec2.InstanceType(props.instanceType ?? 't3.medium'),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup,
      role: instanceRole,
      userData,
      userDataCausesReplacement: false,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(20, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
    });
    this.instance.instance.node.addDependency(this.eip);

    new ec2.CfnEIPAssociation(this, 'EipAssociation', {
      allocationId: this.eip.attrAllocationId,
      instanceId: this.instance.instanceId,
    });

    // DNS: point the domain directly at the Elastic IP.
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.hostedZoneName,
    });

    new route53.ARecord(this, 'DnsRecord', {
      zone: hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromIpAddresses(this.eip.ref),
      ttl: cdk.Duration.minutes(5),
    });

    // Nightly shutdown: stop the instance during low-traffic hours to
    // save on EC2 compute billing (EBS storage still bills regardless).
    // A plain stop/start on the SAME instance keeps the Elastic IP
    // associated automatically — no re-association needed on startup.
    if (props.nightlyShutdown?.enabled) {
      const { shutdownCron, startupCron } = props.nightlyShutdown;

      new events.Rule(this, 'NightlyInstanceStop', {
        ruleName: `${stackName}-nightly-stop`,
        schedule: events.Schedule.expression(`cron(${shutdownCron})`),
        targets: [
          new events_targets.AwsApi({
            service: 'EC2',
            action: 'stopInstances',
            parameters: { InstanceIds: [this.instance.instanceId] },
          }),
        ],
      });

      new events.Rule(this, 'MorningInstanceStart', {
        ruleName: `${stackName}-morning-start`,
        schedule: events.Schedule.expression(`cron(${startupCron})`),
        targets: [
          new events_targets.AwsApi({
            service: 'EC2',
            action: 'startInstances',
            parameters: { InstanceIds: [this.instance.instanceId] },
          }),
        ],
      });
    }

    // CodeDeploy: application + deployment group targeting this instance
    // by tag. The actual deploy content (appspec.yml, hooks) lives in the
    // backend repo, pushed to CodeDeploy by the pipeline's Deploy stage.
    this.codeDeployApplication = new codedeploy.ServerApplication(this, 'CodeDeployApplication', {
      applicationName: `${stackName}-app`,
    });

    const codeDeployServiceRole = new iam.Role(this, 'CodeDeployServiceRole', {
      roleName: `${stackName}-codedeploy-service-role`,
      assumedBy: new iam.ServicePrincipal('codedeploy.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSCodeDeployRole'),
      ],
    });

    cdk.Tags.of(this.instance).add('CodeDeployTarget', stackName);

    this.codeDeployDeploymentGroup = new codedeploy.ServerDeploymentGroup(this, 'CodeDeployDeploymentGroup', {
      application: this.codeDeployApplication,
      deploymentGroupName: `${stackName}-deployment-group`,
      role: codeDeployServiceRole,
      ec2InstanceTags: new codedeploy.InstanceTagSet({
        CodeDeployTarget: [stackName],
      }),
      installAgent: false, // installed via user-data instead
      deploymentConfig: codedeploy.ServerDeploymentConfig.ALL_AT_ONCE,
    });

    // CodeBuild: builds the Docker image (same as PipelineStack's ECS
    // path) but with a separate buildspec that produces a CodeDeploy
    // bundle (appspec.yml + hook scripts + imagedefinitions.json)
    // instead of the ECS-style imagedefinitions.json-only artifact.
    const codeBuildRole = new iam.Role(this, 'CodeBuildRole', {
      roleName: `${stackName}-codebuild-role`,
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    });

    codeBuildRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [
          `arn:aws:logs:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:log-group:/aws/codebuild/${stackName}*`,
        ],
      })
    );
    codeBuildRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      })
    );

    const buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
      projectName: `${stackName}-build`,
      role: codeBuildRole,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: true,
        environmentVariables: {
          AWS_ACCOUNT_ID: { value: cdk.Stack.of(this).account },
          AWS_DEFAULT_REGION: { value: cdk.Stack.of(this).region },
          ECR_REPOSITORY_URI: { value: props.ecrRepository.repositoryUri },
        },
      },
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec-ec2.yml'),
      logging: {
        cloudWatch: {
          logGroup: new logs.LogGroup(this, 'BuildLogGroup', {
            logGroupName: `/aws/codebuild/${stackName}`,
            retention: props.loggingConfig.retentionDays,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
          }),
        },
      },
    });
    props.ecrRepository.grantPullPush(buildProject);

    // CodePipeline: Source -> Build -> CodeDeploy
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
          actionName: 'Docker_Build',
          project: buildProject,
          input: sourceOutput,
          outputs: [buildOutput],
        }),
      ],
    });

    pipeline.addStage({
      stageName: 'Deploy',
      actions: [
        new codepipeline_actions.CodeDeployServerDeployAction({
          actionName: 'CodeDeploy_EC2',
          deploymentGroup: this.codeDeployDeploymentGroup,
          input: buildOutput,
        }),
      ],
    });

    // Outputs
    new cdk.CfnOutput(this, 'InstanceId', {
      value: this.instance.instanceId,
      description: 'EC2 instance ID',
    });

    new cdk.CfnOutput(this, 'ElasticIp', {
      value: this.eip.ref,
      description: 'Elastic IP address',
    });

    new cdk.CfnOutput(this, 'ApplicationDomain', {
      value: props.domainName,
      description: 'Domain name pointed at this instance',
    });

    new cdk.CfnOutput(this, 'CodeDeployApplicationName', {
      value: this.codeDeployApplication.applicationName,
      exportName: `${stackName}:CodeDeployApplicationName`,
    });

    new cdk.CfnOutput(this, 'CodeDeployDeploymentGroupName', {
      value: this.codeDeployDeploymentGroup.deploymentGroupName,
      exportName: `${stackName}:CodeDeployDeploymentGroupName`,
    });

    // Tags
    cdk.Tags.of(this).add('Project', props.projectName);
    cdk.Tags.of(this).add('Environment', props.environment);
    cdk.Tags.of(this).add('Stack', stackName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
  }
}
