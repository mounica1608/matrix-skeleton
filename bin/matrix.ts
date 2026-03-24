#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NetworkingStack } from '../lib/networking/networking-stack';
import { SharedResourcesStack } from '../lib/shared/shared-resources-stack';
import { CertificateStack } from '../lib/shared/certificate-stack';
import { PipelineStack } from '../lib/pipeline/pipeline-stack';
import { StagingAlbStack } from '../lib/alb/staging-alb-stack';
import { ProductionAlbStack } from '../lib/alb/production-alb-stack';
import { DnsStack } from '../lib/shared/dns-stack';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

import { ElastiCacheStack } from '../lib/shared/elasticache-stack';
import { ScheduledTaskStack } from '../lib/shared/scheduled-task-stack';
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

// ─── Certificates ────────────────────────────────────────────────────────────
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

// ─── ALB Stacks ──────────────────────────────────────────────────────────────
const stagingAlbStack = new StagingAlbStack(app, 'StagingAlbStack', {
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

// Production ALB (uncomment when domain is ready)
// const productionAlbStack = new ProductionAlbStack(app, 'ProductionAlbStack', {
//   env: env,
//   vpc: networkingStack.vpc,
//   albSecurityGroup: networkingStack.albSecurityGroup,
//   certificate: productionCertificateStack.certificate,
//   description: 'Shared ALB for production environment',
//   tags: {
//     ...commonConfig.tags,
//     Environment: 'production',
//   },
// });
// productionAlbStack.addDependency(networkingStack);
// productionAlbStack.addDependency(productionCertificateStack);

// ─── ElastiCache Redis (required by CaseMaster for Celery) ──────────────────
const casemasterRedisStack = new ElastiCacheStack(app, 'CasemasterRedisStack', {
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

// ─── CaseMaster AI ──────────────────────────────────────────────────────────
// Shared resources (ECR, S3, SNS) for CaseMaster
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

// CaseMaster — Dev Pipeline (HTTPS, host-based routing)
const casemasterDevStack = new PipelineStack(
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

// ─── DNS ─────────────────────────────────────────────────────────────────────
const stagingDnsStack = new DnsStack(app, 'StagingDnsStack', {
  env: env,
  hostedZoneId: commonConfig.hostedZone.id,
  hostedZoneName: commonConfig.hostedZone.name,
  records: [
    {
      subdomain: 'api-dev',
      alb: stagingAlbStack.alb,
    },
  ],
  description: 'Route53 DNS records for staging/dev domain-based services',
  tags: {
    ...commonConfig.tags,
    Environment: 'staging',
  },
});
stagingDnsStack.addDependency(stagingAlbStack);

app.synth();
