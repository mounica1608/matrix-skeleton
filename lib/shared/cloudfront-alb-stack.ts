import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

export interface CloudFrontAlbStackProps extends cdk.StackProps {
  alb: elbv2.IApplicationLoadBalancer;
}

export class CloudFrontAlbStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: CloudFrontAlbStackProps) {
    super(scope, id, props);

    // CloudFront distribution in front of ALB
    // Provides HTTPS via *.cloudfront.net without needing a custom domain
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: new origins.HttpOrigin(props.alb.loadBalancerDnsName, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          httpPort: 80,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
      comment: 'HTTPS proxy for staging ALB',
      enableIpv6: false,
    });

    // Outputs
    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'CloudFront HTTPS URL for the staging ALB',
      exportName: 'StagingCloudFront:DomainName',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront Distribution ID',
      exportName: 'StagingCloudFront:DistributionId',
    });

    cdk.Tags.of(this).add('Stack', 'CloudFrontAlbStack');
    cdk.Tags.of(this).add('Environment', 'staging');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
  }
}
