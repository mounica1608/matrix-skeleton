import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface SidecarContainer {
  name: string;
  command: string[];
}

export interface PipelineStackProps extends cdk.StackProps {
  projectName: string;
  environment: string;
  ssmEnvironment?: string;
  vpc: ec2.IVpc;
  ecsSecurityGroup: ec2.ISecurityGroup;
  // Shared ALB resources
  alb: elbv2.IApplicationLoadBalancer;
  httpListener: elbv2.IApplicationListener;
  listenerRulePriority: number;
  pathPattern?: string;
  hostHeader?: string;
  ecrRepository: ecr.IRepository;
  artifactBucket: s3.IBucket;
  alarmTopic: sns.ITopic;
  githubConnection: string;
  githubRepo: string;
  githubBranch: string;
  containerPort: number;
  healthCheckPath: string;
  requiredEnvVars: string[];
  fargateConfig: {
    cpu: number;
    memory: number;
    desiredCount: number;
  };
  autoScalingConfig?: {
    enabled: boolean;
    minCapacity: number;
    maxCapacity: number;
    targetCpuUtilization: number;
  };
  loggingConfig: {
    retentionDays: number;
  };
  redisEndpoint?: string;
  sidecars?: SidecarContainer[];
}

export class PipelineStack extends cdk.Stack {
  public readonly ecsService: ecs.FargateService;

  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const stackName = `${props.projectName}-${props.environment}`;

    // IAM: ECS task execution role (pulls images + reads SSM secrets)
    const ecsTaskExecutionRole = new iam.Role(this, 'EcsTaskExecutionRole', {
      roleName: `${stackName}-ecs-task-execution-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    const ssmParameterPrefix = `${props.projectName}/${props.ssmEnvironment || props.environment}`;
    ecsTaskExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameters'],
        resources: [
          `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter/${ssmParameterPrefix}/*`,
        ],
      })
    );

    // IAM: ECS task role (what the running container can do)
    const ecsTaskRole = new iam.Role(this, 'EcsTaskRole', {
      roleName: `${stackName}-ecs-task-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // SSM permissions for ECS Exec (interactive shell access)
    ecsTaskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ssmmessages:CreateControlChannel',
          'ssmmessages:CreateDataChannel',
          'ssmmessages:OpenControlChannel',
          'ssmmessages:OpenDataChannel',
        ],
        resources: ['*'],
      })
    );

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
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      })
    );

    codeBuildRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
          'ecr:PutImage',
          'ecr:InitiateLayerUpload',
          'ecr:UploadLayerPart',
          'ecr:CompleteLayerUpload',
        ],
        resources: [props.ecrRepository.repositoryArn],
      })
    );

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `${stackName}-cluster`,
      vpc: props.vpc,
    });

    // Target Group for this service
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'ServiceTargetGroup', {
      port: props.containerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      vpc: props.vpc,
      healthCheck: {
        path: props.healthCheckPath,
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // ALB listener rule: host-based and/or path-based routing
    const conditions: elbv2.ListenerCondition[] = [];

    if (props.hostHeader) {
      conditions.push(elbv2.ListenerCondition.hostHeaders([props.hostHeader]));
    }

    if (props.pathPattern) {
      conditions.push(elbv2.ListenerCondition.pathPatterns([props.pathPattern]));
    }

    if (conditions.length === 0) {
      throw new Error('Either hostHeader or pathPattern must be specified for ALB routing');
    }

    new elbv2.ApplicationListenerRule(this, 'ListenerRule', {
      listener: props.httpListener,
      priority: props.listenerRulePriority,
      conditions: conditions,
      targetGroups: [targetGroup],
    });

    // CloudWatch Log Group
    const logGroup = new logs.LogGroup(this, 'EcsLogGroup', {
      logGroupName: `/ecs/${stackName}`,
      retention: props.loggingConfig.retentionDays,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ECS Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      family: `${stackName}-task`,
      cpu: props.fargateConfig.cpu,
      memoryLimitMiB: props.fargateConfig.memory,
      executionRole: ecsTaskExecutionRole,
      taskRole: ecsTaskRole,
    });

    // Redis connection env vars (when ElastiCache endpoint is provided)
    const redisEnvVars: Record<string, string> = {};
    if (props.redisEndpoint) {
      redisEnvVars['REDIS_URL']                = `redis://${props.redisEndpoint}:6379/1`;
      redisEnvVars['CELERY_BROKER_URL']        = `redis://${props.redisEndpoint}:6379/0`;
      redisEnvVars['CELERY_RESULT_BACKEND']    = `redis://${props.redisEndpoint}:6379/0`;
      redisEnvVars['CELERY_REDBEAT_REDIS_URL'] = `redis://${props.redisEndpoint}:6379/2`;
    }

    // Shared ephemeral volume for data exchange between containers (uploads, results, etc.)
    taskDefinition.addVolume({
      name: 'shared-data',
    });

    // Shared env + secrets for all containers in the task
    const sharedEnv = {
      ENVIRONMENT: props.environment,
      PROJECT_NAME: props.projectName,
      LLM_MAX_OUTPUT_TOKENS: '8192',         // lower = faster map calls (min ~4096)
      STRATEGY_MAX_OUTPUT_TOKENS: '32768', // strategy JSON can be large; gemini-2.5-flash thinking tokens eat into budget
      LLM_CONCURRENCY: '5',                // max parallel LLM calls
      TRANSLATION_BATCH_SIZE: '10',        // pages bundled per translation LLM call
      JWT_LEEWAY_SECONDS: '120',
      OLLAMA_URL: 'http://ollama:11434',   // only used when LLM_PROVIDER=ollama
      // Retrieval / reranker tuning
      EMBEDDING_MODEL: 'BAAI/bge-small-en-v1.5', // MUST match the model the dev precedent DB was re-embedded with
      RERANK_ENABLED: 'true',              // defaults to false — set true to turn the reranker ON
      RERANKER_MODEL: 'BAAI/bge-reranker-base',
      RERANK_MIN_SCORE: '0.10',
      RERANK_BATCH_SIZE: '64',
      RERANK_TORCH_THREADS: '2',           // sized to dev's 1-vCPU task; raise for larger prod boxes
      OMP_NUM_THREADS: '2',                // sized to dev's 1-vCPU task; raise for larger prod boxes
      MKL_NUM_THREADS: '2',                // sized to dev's 1-vCPU task; raise for larger prod boxes
      HYBRID_RETRIEVAL: 'true',
      REPORT_CACHE_ENABLED: 'true',
      PRECEDENT_IVFFLAT_PROBES: '30',
      PRECEDENT_QUESTION_CONCURRENCY: '5',
      // OTP / WhatsApp
      OTP_PROVIDER: 'whatsapp_meta',       // or msg91
      WHATSAPP_TEMPLATE_LANG: 'en_US',
      WHATSAPP_GRAPH_VERSION: 'v21.0',
      ...redisEnvVars,
    };
    const sharedSecrets = this.buildSecretsFromEnvVars(props.requiredEnvVars, ssmParameterPrefix);

    // Primary container — port-mapped and registered with ALB
    const appContainer = taskDefinition.addContainer('AppContainer', {
      containerName: `${stackName}-container`,
      image: ecs.ContainerImage.fromEcrRepository(
        props.ecrRepository,
        props.environment
      ),
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: 'ecs',
        logGroup: logGroup,
      }),
      environment: sharedEnv,
      secrets: sharedSecrets,
      portMappings: [
        {
          containerPort: props.containerPort,
          protocol: ecs.Protocol.TCP,
        },
      ],
    });
    appContainer.addMountPoints({
      sourceVolume: 'shared-data',
      containerPath: '/data',
      readOnly: false,
    });

    // Sidecar containers (e.g. celery worker, celery-beat)
    if (props.sidecars) {
      for (const sidecar of props.sidecars) {
        const sidecarContainer = taskDefinition.addContainer(`${sidecar.name}Container`, {
          containerName: `${stackName}-${sidecar.name}`,
          image: ecs.ContainerImage.fromEcrRepository(
            props.ecrRepository,
            props.environment
          ),
          command: sidecar.command,
          logging: ecs.LogDriver.awsLogs({
            streamPrefix: sidecar.name,
            logGroup: logGroup,
          }),
          environment: sharedEnv,
          secrets: sharedSecrets,
        });
        sidecarContainer.addMountPoints({
          sourceVolume: 'shared-data',
          containerPath: '/data',
          readOnly: false,
        });
      }
    }

    // ECS Fargate Service
    this.ecsService = new ecs.FargateService(this, 'Service', {
      serviceName: `${stackName}-service`,
      cluster: cluster,
      taskDefinition: taskDefinition,
      desiredCount: props.fargateConfig.desiredCount,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.ecsSecurityGroup],
      healthCheckGracePeriod: cdk.Duration.seconds(60),
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
      enableExecuteCommand: true,
    });

    this.ecsService.attachToApplicationTargetGroup(targetGroup);

    // Auto-scaling
    if (props.autoScalingConfig?.enabled) {
      const scaling = this.ecsService.autoScaleTaskCount({
        minCapacity: props.autoScalingConfig.minCapacity,
        maxCapacity: props.autoScalingConfig.maxCapacity,
      });

      scaling.scaleOnCpuUtilization('CpuScaling', {
        targetUtilizationPercent: props.autoScalingConfig.targetCpuUtilization,
        scaleInCooldown: cdk.Duration.seconds(60),
        scaleOutCooldown: cdk.Duration.seconds(60),
      });
    }

    // CodeBuild Project
    const buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
      projectName: `${stackName}-build`,
      role: codeBuildRole,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: true,
        environmentVariables: {
          AWS_ACCOUNT_ID: {
            value: cdk.Stack.of(this).account,
          },
          AWS_DEFAULT_REGION: {
            value: cdk.Stack.of(this).region,
          },
          ECR_REPOSITORY_URI: {
            value: props.ecrRepository.repositoryUri,
          },
          ENV: {
            value: props.environment,
          },
          IMAGE_TAG: {
            value: props.environment,
          },
          PROJECT_NAME: {
            value: props.projectName,
          },
          ENVIRONMENT: {
            value: props.environment,
          },
        },
      },
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec.yml'),
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

    // CodePipeline: Source -> Build -> Deploy
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
        new codepipeline_actions.EcsDeployAction({
          actionName: 'ECS_Deploy',
          service: this.ecsService,
          input: buildOutput,
        }),
      ],
    });

    // CloudWatch Alarms
    const cpuAlarm = new cloudwatch.Alarm(this, 'HighCpuAlarm', {
      alarmName: `${stackName}-high-cpu`,
      metric: this.ecsService.metricCpuUtilization(),
      threshold: 80,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      actionsEnabled: true,
    });
    cpuAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(props.alarmTopic));

    const memoryAlarm = new cloudwatch.Alarm(this, 'HighMemoryAlarm', {
      alarmName: `${stackName}-high-memory`,
      metric: this.ecsService.metricMemoryUtilization(),
      threshold: 85,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      actionsEnabled: true,
    });
    memoryAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(props.alarmTopic));

    const unhealthyTargetAlarm = new cloudwatch.Alarm(this, 'UnhealthyTargetAlarm', {
      alarmName: `${stackName}-unhealthy-targets`,
      metric: targetGroup.metrics.unhealthyHostCount(),
      threshold: 1,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      actionsEnabled: true,
    });
    unhealthyTargetAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(props.alarmTopic));

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
    if (props.pathPattern) {
      new cdk.CfnOutput(this, 'ApplicationPath', {
        value: props.pathPattern,
        description: 'Path pattern for this service on shared ALB',
      });
    }

    if (props.hostHeader) {
      new cdk.CfnOutput(this, 'ApplicationDomain', {
        value: props.hostHeader,
        description: 'Domain name for this service on shared ALB',
      });
    }

    new cdk.CfnOutput(this, 'EcsClusterName', {
      value: cluster.clusterName,
      description: 'ECS Cluster name',
      exportName: `${stackName}:ClusterName`,
    });

    new cdk.CfnOutput(this, 'EcsServiceName', {
      value: this.ecsService.serviceName,
      description: 'ECS Service name',
      exportName: `${stackName}:ServiceName`,
    });

    // Tag all resources
    cdk.Tags.of(this).add('Project', props.projectName);
    cdk.Tags.of(this).add('Environment', props.environment);
    cdk.Tags.of(this).add('Stack', stackName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
  }

  private buildSecretsFromEnvVars(
    requiredEnvVars: string[],
    ssmParameterPrefix: string
  ): { [key: string]: ecs.Secret } {
    const secrets: { [key: string]: ecs.Secret } = {};

    requiredEnvVars.forEach((envVar) => {
      const parameterPath = `/${ssmParameterPrefix}/${envVar}`;
      secrets[envVar] = ecs.Secret.fromSsmParameter(
        ssm.StringParameter.fromStringParameterName(
          this,
          envVar,
          parameterPath
        )
      );
    });

    return secrets;
  }
}
