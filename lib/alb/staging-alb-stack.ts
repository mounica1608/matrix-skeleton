import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';

export interface StagingAlbStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  albSecurityGroup: ec2.ISecurityGroup;
  certificate?: acm.ICertificate;
}

export class StagingAlbStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly httpListener: elbv2.ApplicationListener;
  public readonly httpsListener: elbv2.ApplicationListener;

  constructor(scope: Construct, id: string, props: StagingAlbStackProps) {
    super(scope, id, props);

    // Staging/Dev shared ALB
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      loadBalancerName: 'staging-shared-alb',
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // HTTP listener - returns 404 by default, services add their own rules
    this.httpListener = this.alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Not Found',
      }),
    });

    // HTTPS listener - only created when certificate is provided
    if (props.certificate) {
      this.httpsListener = this.alb.addListener('HttpsListener', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [props.certificate],
        defaultAction: elbv2.ListenerAction.fixedResponse(404, {
          contentType: 'text/plain',
          messageBody: 'Not Found',
        }),
      });

      new cdk.CfnOutput(this, 'HttpsListenerArn', {
        value: this.httpsListener.listenerArn,
        description: 'HTTPS Listener ARN',
        exportName: 'StagingAlb:HttpsListenerArn',
      });
    }

    // Outputs
    new cdk.CfnOutput(this, 'AlbDns', {
      value: this.alb.loadBalancerDnsName,
      description: 'Staging/Dev ALB DNS name',
      exportName: 'StagingAlb:Dns',
    });

    new cdk.CfnOutput(this, 'AlbArn', {
      value: this.alb.loadBalancerArn,
      description: 'Staging/Dev ALB ARN',
      exportName: 'StagingAlb:Arn',
    });

    new cdk.CfnOutput(this, 'HttpListenerArn', {
      value: this.httpListener.listenerArn,
      description: 'HTTP Listener ARN',
      exportName: 'StagingAlb:HttpListenerArn',
    });

    cdk.Tags.of(this).add('Stack', 'StagingAlbStack');
    cdk.Tags.of(this).add('Environment', 'staging');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
  }
}
