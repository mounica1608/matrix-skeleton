import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { Construct } from 'constructs';

export interface DnsRecordConfig {
  subdomain: string;
  alb?: elbv2.IApplicationLoadBalancer;
  distribution?: cloudfront.IDistribution;
}

export interface DnsStackProps extends cdk.StackProps {
  hostedZoneId: string;
  hostedZoneName: string;
  records: DnsRecordConfig[];
}

export class DnsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);

    // Import the existing hosted zone
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(
      this,
      'HostedZone',
      {
        hostedZoneId: props.hostedZoneId,
        zoneName: props.hostedZoneName,
      }
    );

    // Create A records for each subdomain (empty subdomain = apex/bare domain)
    for (const record of props.records) {
      const recordName = record.subdomain
        ? `${record.subdomain}.${props.hostedZoneName}`
        : props.hostedZoneName;
      const idSuffix = record.subdomain || 'apex';

      if (!record.alb && !record.distribution) {
        throw new Error(
          `DNS record for '${idSuffix}' must specify either 'alb' or 'distribution'`
        );
      }

      const recordTarget = record.distribution
        ? route53.RecordTarget.fromAlias(
            new targets.CloudFrontTarget(record.distribution)
          )
        : route53.RecordTarget.fromAlias(
            new targets.LoadBalancerTarget(record.alb!)
          );

      new route53.ARecord(this, `ARecord-${idSuffix}`, {
        zone: hostedZone,
        recordName: recordName,
        target: recordTarget,
        comment: `Managed by CDK - points to ${
          record.distribution ? 'CloudFront distribution' : 'ALB'
        } for ${idSuffix}`,
      });

      new cdk.CfnOutput(this, `DnsRecord-${idSuffix}`, {
        value: recordName,
        description: `DNS record for ${idSuffix}`,
      });
    }

    cdk.Tags.of(this).add('Stack', id);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
  }
}
