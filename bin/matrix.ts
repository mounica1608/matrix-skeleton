#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NetworkingStack } from '../lib/networking/networking-stack';
import { SharedResourcesStack } from '../lib/shared/shared-resources-stack';
import { CertificateStack } from '../lib/shared/certificate-stack';
import { PipelineStack } from '../lib/pipeline/pipeline-stack';
import { FrontendStack } from '../lib/frontend/frontend-stack';
import { StagingAlbStack } from '../lib/alb/staging-alb-stack';
import { ProductionAlbStack } from '../lib/alb/production-alb-stack';
import { DnsStack } from '../lib/shared/dns-stack';
import { Ec2Stack } from '../lib/ec2/ec2-stack';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

import { ElastiCacheStack } from '../lib/shared/elasticache-stack';
import { ScheduledTaskStack } from '../lib/shared/scheduled-task-stack';
import { MonitoringStack } from '../lib/shared/monitoring-stack';
import * as events from 'aws-cdk-lib/aws-events';

// Import configuration
import * as commonConfig from '../config/common.json';
import * as projectsConfig from '../config/projects.json';
import * as devConfig from '../config/dev.json';
import * as stagingConfig from '../config/staging.json';
import * as productionConfig from '../config/production.json';

const app = new cdk.App();

// Define environment
const env = {
  account: commonConfig.accountId,
  region: commonConfig.region,
};

// ─── Networking ──────────────────────────────────────────────────────────────
const networkingStack = new NetworkingStack(app, 'NetworkingStack', {
  env: env,
  description: 'VPC, subnets, security groups, and VPC endpoints',
  tags: commonConfig.tags,
});

// ─── Compute mode ────────────────────────────────────────────────────────────
// "ecs"  = ECS Fargate behind a shared ALB, ElastiCache Redis (higher cost,
//          autoscaling, managed health checks/rolling deploys).
// "ec2"  = single EC2 instance running docker-compose (app + celery-worker +
//          self-hosted Redis + Caddy for TLS), no ALB. Cheaper, no
//          autoscaling, deploys via CodeDeploy.
// Switch by changing config/common.json's computeMode and running
// `cdk deploy --all` — CDK creates the newly-active stacks and leaves the
// inactive ones' resources alone (their stacks just won't be in `cdk list`
// until you switch back; destroy them separately when cutting over to
// avoid paying for both simultaneously).
const computeMode: 'ecs' | 'ec2' = (commonConfig as any).computeMode ?? 'ecs';

// ─── CaseMaster AI: shared resources (ECR, S3, SNS) ─────────────────────────
const casemasterSharedStack = new SharedResourcesStack(
  app,
  'CasemasterSharedStack',
  {
    env: env,
    projectName: projectsConfig.casemaster.name,
    ecrRepositoryName: projectsConfig.casemaster.ecrRepositoryName,
    alarmEmail: projectsConfig.casemaster.alarmEmail,
    description: 'Shared resources for CaseMaster AI (ECR, S3, SNS)',
    tags: {
      ...commonConfig.tags,
      Project: projectsConfig.casemaster.name,
    },
  }
);

let casemasterDevStack: PipelineStack | undefined;
let stagingAlbStack: StagingAlbStack | undefined;
let casemasterRedisStack: ElastiCacheStack | undefined;
let casemasterEc2Stack: Ec2Stack | undefined;

if (computeMode === 'ecs') {
  // ─── Certificates ────────────────────────────────────────────────────────
  const stagingCertificateStack = new CertificateStack(
    app,
    'StagingCertificateStack',
    {
      env: env,
      domainName: `*.${commonConfig.hostedZone.name}`,
      hostedZoneId: commonConfig.hostedZone.id,
      hostedZoneName: commonConfig.hostedZone.name,
      description: 'Wildcard SSL certificate for staging and dev environments',
      tags: {
        ...commonConfig.tags,
        Environment: 'staging',
      },
    }
  );

  // ─── ALB Stacks ────────────────────────────────────────────────────────────
  stagingAlbStack = new StagingAlbStack(app, 'StagingAlbStack', {
    env: env,
    vpc: networkingStack.vpc,
    albSecurityGroup: networkingStack.albSecurityGroup,
    certificate: stagingCertificateStack.certificate,
    description: 'Shared ALB for staging and dev environments',
    tags: {
      ...commonConfig.tags,
      Environment: 'staging',
    },
  });
  stagingAlbStack.addDependency(networkingStack);
  stagingAlbStack.addDependency(stagingCertificateStack);

  // ─── ElastiCache Redis (required by CaseMaster for Celery) ───────────────
  casemasterRedisStack = new ElastiCacheStack(app, 'CasemasterRedisStack', {
    env: env,
    vpc: networkingStack.vpc,
    ecsSecurityGroup: networkingStack.ecsSecurityGroup,
    projectName: projectsConfig.casemaster.name,
    environment: 'dev',
    description: 'ElastiCache Redis for CaseMaster (Celery broker + cache)',
    tags: {
      ...commonConfig.tags,
      Project: projectsConfig.casemaster.name,
      Environment: 'dev',
    },
  });
  casemasterRedisStack.addDependency(networkingStack);

  // CaseMaster — Dev Pipeline (HTTPS, host-based routing)
  casemasterDevStack = new PipelineStack(
    app,
    'CasemasterDevStack',
    {
      env: env,
      projectName: projectsConfig.casemaster.name,
      environment: devConfig.environment,
      vpc: networkingStack.vpc,
      ecsSecurityGroup: networkingStack.ecsSecurityGroup,
      alb: stagingAlbStack.alb,
      httpListener: elbv2.ApplicationListener.fromApplicationListenerAttributes(app, 'ImportedHttpsListener', {
        listenerArn: cdk.Fn.importValue('StagingAlb:HttpsListenerArn'),
        securityGroup: networkingStack.albSecurityGroup,
      }),
      listenerRulePriority: 100,
      hostHeader: projectsConfig.casemaster.domains.dev,
      ecrRepository: casemasterSharedStack.ecrRepository,
      artifactBucket: casemasterSharedStack.artifactBucket,
      alarmTopic: casemasterSharedStack.alarmTopic,
      githubConnection: commonConfig.githubConnection,
      githubRepo: projectsConfig.casemaster.githubRepo,
      githubBranch: devConfig.githubBranch,
      containerPort: projectsConfig.casemaster.containerPort,
      healthCheckPath: projectsConfig.casemaster.healthCheckPath,
      requiredEnvVars: projectsConfig.casemaster.requiredEnvVars,
      fargateConfig: devConfig.fargate,
      autoScalingConfig: devConfig.autoScaling,
      loggingConfig: devConfig.logging,
      redisEndpoint: casemasterRedisStack.redisEndpoint,
      sidecars: [
        {
          name: 'celery-worker',
          command: ['celery', '-A', 'app.main:celery', 'worker', '--loglevel=info', '--concurrency=2'],
        },
      ],
      description: 'CI/CD pipeline for CaseMaster AI dev environment',
      tags: {
        ...commonConfig.tags,
        Project: projectsConfig.casemaster.name,
        Environment: devConfig.environment,
      },
    }
  );
  casemasterDevStack.addDependency(stagingAlbStack);
  casemasterDevStack.addDependency(casemasterSharedStack);
  casemasterDevStack.addDependency(casemasterRedisStack);
} else {
  // ─── EC2 (cost-cut mode): single instance, docker-compose, Caddy TLS ─────
  casemasterEc2Stack = new Ec2Stack(app, 'CasemasterEc2Stack', {
    env: env,
    vpc: networkingStack.vpc,
    projectName: projectsConfig.casemaster.name,
    environment: devConfig.environment,
    ecrRepository: casemasterSharedStack.ecrRepository,
    artifactBucket: casemasterSharedStack.artifactBucket,
    requiredEnvVars: projectsConfig.casemaster.requiredEnvVars,
    hostedZoneId: commonConfig.hostedZone.id,
    hostedZoneName: commonConfig.hostedZone.name,
    domainName: projectsConfig.casemaster.domains.dev,
    alarmTopic: casemasterSharedStack.alarmTopic,
    githubConnection: commonConfig.githubConnection,
    githubRepo: projectsConfig.casemaster.githubRepo,
    githubBranch: devConfig.githubBranch,
    loggingConfig: devConfig.logging,
    instanceType: (devConfig as any).ec2?.instanceType,
    nightlyShutdown: (devConfig as any).ec2?.nightlyShutdown,
    description: 'EC2 instance + CodeDeploy pipeline for CaseMaster AI dev environment (cost-cut mode)',
    tags: {
      ...commonConfig.tags,
      Project: projectsConfig.casemaster.name,
      Environment: devConfig.environment,
    },
  });
  casemasterEc2Stack.addDependency(networkingStack);
  casemasterEc2Stack.addDependency(casemasterSharedStack);
}

// ─── CaseMaster Frontend ─────────────────────────────────────────────────────
// CloudFront requires its ACM certificate in us-east-1, regardless of the app's home region.
const frontendCertificateStack = new CertificateStack(
  app,
  'FrontendCertificateStack',
  {
    env: { account: commonConfig.accountId, region: 'us-east-1' },
    crossRegionReferences: true,
    domainName: projectsConfig.casemaster.frontend.domains.dev,
    hostedZoneId: commonConfig.hostedZone.id,
    hostedZoneName: commonConfig.hostedZone.name,
    description: 'us-east-1 SSL certificate for the CaseMaster frontend CloudFront distribution',
    tags: {
      ...commonConfig.tags,
      Environment: 'staging',
    },
  }
);

const casemasterFrontendDevStack = new FrontendStack(
  app,
  'CasemasterFrontendDevStack',
  {
    env: env,
    crossRegionReferences: true,
    projectName: projectsConfig.casemaster.frontend.name,
    ssmParameterPrefix: `${projectsConfig.casemaster.name}/${devConfig.environment}`,
    environment: devConfig.environment,
    domainName: projectsConfig.casemaster.frontend.domains.dev,
    certificate: frontendCertificateStack.certificate,
    artifactBucket: casemasterSharedStack.artifactBucket,
    alarmTopic: casemasterSharedStack.alarmTopic,
    githubConnection: commonConfig.githubConnection,
    githubRepo: projectsConfig.casemaster.frontend.githubRepo,
    githubBranch: projectsConfig.casemaster.frontend.githubBranch,
    buildEnvVars: projectsConfig.casemaster.frontend.frontendEnvVars,
    description: 'CI/CD pipeline and CloudFront hosting for CaseMaster AI frontend dev environment',
    tags: {
      ...commonConfig.tags,
      Project: projectsConfig.casemaster.frontend.name,
      Environment: devConfig.environment,
    },
  }
);
casemasterFrontendDevStack.addDependency(frontendCertificateStack);
casemasterFrontendDevStack.addDependency(casemasterSharedStack);

// ─── DNS ─────────────────────────────────────────────────────────────────────
// In "ec2" mode, api-dev's A record is created directly by Ec2Stack
// (pointing at the instance's Elastic IP) — don't create a competing
// record here, Route53 would just fight over which one "wins".
const dnsRecords: any[] = [
  {
    subdomain: '',
    distribution: casemasterFrontendDevStack.distribution,
  },
];
if (computeMode === 'ecs' && stagingAlbStack) {
  dnsRecords.push({
    subdomain: 'api-dev',
    alb: stagingAlbStack.alb,
  });
}

const stagingDnsStack = new DnsStack(app, 'StagingDnsStack', {
  env: env,
  hostedZoneId: commonConfig.hostedZone.id,
  hostedZoneName: commonConfig.hostedZone.name,
  records: dnsRecords,
  description: 'Route53 DNS records for staging/dev domain-based services',
  tags: {
    ...commonConfig.tags,
    Environment: 'staging',
  },
});
if (stagingAlbStack) {
  stagingDnsStack.addDependency(stagingAlbStack);
}
stagingDnsStack.addDependency(casemasterFrontendDevStack);

// ─── Monitoring ─────────────────────────────────────────────────────────────
// ECS/ALB/Redis-specific alarms only apply in "ecs" mode — in "ec2" mode
// those resources don't exist, so referencing them would either fail to
// synth (CDK object refs) or just alarm on permanently-missing metrics.
if (computeMode === 'ecs' && stagingAlbStack && casemasterRedisStack) {
  const monitoringStack = new MonitoringStack(app, 'MonitoringStack', {
    env: env,
    monitoringConfig: (commonConfig as any).monitoring,
    ecsServices: [
      {
        projectName: projectsConfig.casemaster.name,
        environment: devConfig.environment,
        clusterName: `${projectsConfig.casemaster.name}-${devConfig.environment}-cluster`,
        serviceName: `${projectsConfig.casemaster.name}-${devConfig.environment}-service`,
        maxCapacity: devConfig.autoScaling.maxCapacity,
      },
    ],
    codeBuildProjects: [
      { projectName: `${projectsConfig.casemaster.name}-${devConfig.environment}-build` },
    ],
    logGroups: [
      // ECS log group
      { name: `/ecs/${projectsConfig.casemaster.name}-${devConfig.environment}` },
      // CodeBuild log group
      { name: `/aws/codebuild/${projectsConfig.casemaster.name}-${devConfig.environment}` },
    ],
    albs: [
      { name: 'staging-shared-alb', alb: stagingAlbStack.alb },
    ],
    description: 'Infrastructure monitoring alarms, budget alerts, and cost controls',
    tags: {
      ...commonConfig.tags,
      Stack: 'MonitoringStack',
    },
  });
  monitoringStack.addDependency(networkingStack);
  monitoringStack.addDependency(stagingAlbStack);
  monitoringStack.addDependency(casemasterRedisStack);
}

app.synth();
