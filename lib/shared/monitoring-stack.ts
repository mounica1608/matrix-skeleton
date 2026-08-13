import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

export interface MonitoringStackProps extends cdk.StackProps {
  monitoringConfig: {
    alarmEmail: string;
    natGateway: { dailyBytesThresholdGB: number };
    cloudwatchLogs: { dailyBytesThresholdMB: number };
    codeBuild: {
      buildDurationThresholdMinutes: number;
      dailyFailedBuildsThreshold: number;
    };
    ecsTaskChurn: { runningTaskCountZeroPeriods: number };
    ecsAutoScaling: { maxCapacitySustainedMinutes: number };
    elastiCache: {
      memoryThresholdPercent: number;
      cpuThresholdPercent: number;
      clusterName: string;
    };
    alb: { consumedLcuThreshold: number };
    budget: { monthlyLimitUSD: number; alertThresholds: number[] };
  };
  ecsServices: Array<{
    projectName: string;
    environment: string;
    clusterName: string;
    serviceName: string;
    maxCapacity: number;
  }>;
  codeBuildProjects: Array<{ projectName: string }>;
  logGroups: Array<{ name: string }>;
  albs: Array<{ name: string; alb: elbv2.ApplicationLoadBalancer }>;
}

export class MonitoringStack extends cdk.Stack {
  public readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    // SNS topic for infrastructure monitoring alerts
    this.alarmTopic = new sns.Topic(this, 'MonitoringAlarmTopic', {
      topicName: 'infra-monitoring-alerts',
      displayName: 'Infrastructure Monitoring Alerts',
    });

    this.alarmTopic.addSubscription(
      new subscriptions.EmailSubscription(props.monitoringConfig.alarmEmail)
    );

    this.createNatGatewayAlarm(props);
    this.createEcsTaskChurnAlarms(props);
    this.createLogIngestionAlarms(props);
    this.createCodeBuildAlarms(props);
    this.createEcsMaxCapacityAlarms(props);
    this.createElastiCacheAlarms(props);
    this.createAlbLcuAlarms(props);
    this.createBudget(props);

    // Outputs
    new cdk.CfnOutput(this, 'MonitoringTopicArn', {
      value: this.alarmTopic.topicArn,
      exportName: 'MonitoringStack:AlarmTopicArn',
    });

    // Tags
    cdk.Tags.of(this).add('Stack', 'MonitoringStack');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
  }

  /**
   * NAT Gateway data processing — alert if total bytes exceed threshold per day.
   * Uses account-level aggregation (no NatGatewayId dimension) since there is
   * exactly 1 NAT Gateway. If a second is added, this becomes total aggregate
   * which is still the desired behaviour for cost alerting.
   */
  private createNatGatewayAlarm(props: MonitoringStackProps): void {
    const natBytesOut = new cloudwatch.Metric({
      namespace: 'AWS/NATGateway',
      metricName: 'BytesOutToDestination',
      statistic: 'Sum',
      period: cdk.Duration.hours(24),
    });

    const natBytesIn = new cloudwatch.Metric({
      namespace: 'AWS/NATGateway',
      metricName: 'BytesOutToSource',
      statistic: 'Sum',
      period: cdk.Duration.hours(24),
    });

    const natTotalBytes = new cloudwatch.MathExpression({
      expression: 'bytesOut + bytesIn',
      usingMetrics: { bytesOut: natBytesOut, bytesIn: natBytesIn },
      period: cdk.Duration.hours(24),
      label: 'NAT Gateway Total Bytes Processed',
    });

    const alarm = new cloudwatch.Alarm(this, 'NatGatewayHighData', {
      alarmName: 'infra-nat-gateway-high-data-processing',
      metric: natTotalBytes,
      threshold:
        props.monitoringConfig.natGateway.dailyBytesThresholdGB *
        1024 *
        1024 *
        1024,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      actionsEnabled: true,
    });
    alarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.alarmTopic));
  }

  /**
   * ECS task churn — alert when RunningTaskCount drops to 0 for a service,
   * indicating a crash loop or failed deployment draining all tasks.
   */
  private createEcsTaskChurnAlarms(props: MonitoringStackProps): void {
    for (const svc of props.ecsServices) {
      const metric = new cloudwatch.Metric({
        namespace: 'AWS/ECS',
        metricName: 'RunningTaskCount',
        dimensionsMap: {
          ClusterName: svc.clusterName,
          ServiceName: svc.serviceName,
        },
        statistic: 'Minimum',
        period: cdk.Duration.minutes(5),
      });

      const alarm = new cloudwatch.Alarm(
        this,
        `EcsZeroTasks-${svc.projectName}-${svc.environment}`,
        {
          alarmName: `infra-ecs-zero-tasks-${svc.projectName}-${svc.environment}`,
          metric,
          threshold: 1,
          evaluationPeriods:
            props.monitoringConfig.ecsTaskChurn.runningTaskCountZeroPeriods,
          comparisonOperator:
            cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          actionsEnabled: true,
        }
      );
      alarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.alarmTopic));
    }
  }

  /**
   * CloudWatch Log ingestion — alert when daily bytes for any log group
   * exceed threshold, catching debug-mode leaks or error loops.
   */
  private createLogIngestionAlarms(props: MonitoringStackProps): void {
    for (const lg of props.logGroups) {
      const safeName = this.sanitizeName(lg.name);

      const metric = new cloudwatch.Metric({
        namespace: 'AWS/Logs',
        metricName: 'IncomingBytes',
        dimensionsMap: { LogGroupName: lg.name },
        statistic: 'Sum',
        period: cdk.Duration.hours(24),
      });

      const alarm = new cloudwatch.Alarm(this, `LogIngestion-${safeName}`, {
        alarmName: `infra-log-ingestion-high-${safeName}`,
        metric,
        threshold:
          props.monitoringConfig.cloudwatchLogs.dailyBytesThresholdMB *
          1024 *
          1024,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        actionsEnabled: true,
      });
      alarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.alarmTopic));
    }
  }

  /**
   * CodeBuild — two alarms per project:
   *  (a) single build exceeding duration threshold (hung build)
   *  (b) daily failed builds exceeding count threshold
   */
  private createCodeBuildAlarms(props: MonitoringStackProps): void {
    for (const proj of props.codeBuildProjects) {
      // Long-running build
      const durationMetric = new cloudwatch.Metric({
        namespace: 'AWS/CodeBuild',
        metricName: 'Duration',
        dimensionsMap: { ProjectName: proj.projectName },
        statistic: 'Maximum',
        period: cdk.Duration.minutes(5),
      });

      const durationAlarm = new cloudwatch.Alarm(
        this,
        `CodeBuildDuration-${proj.projectName}`,
        {
          alarmName: `infra-codebuild-long-build-${proj.projectName}`,
          metric: durationMetric,
          threshold:
            props.monitoringConfig.codeBuild.buildDurationThresholdMinutes * 60,
          evaluationPeriods: 1,
          comparisonOperator:
            cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          actionsEnabled: true,
        }
      );
      durationAlarm.addAlarmAction(
        new cloudwatch_actions.SnsAction(this.alarmTopic)
      );

      // Daily failures
      const failedMetric = new cloudwatch.Metric({
        namespace: 'AWS/CodeBuild',
        metricName: 'FailedBuilds',
        dimensionsMap: { ProjectName: proj.projectName },
        statistic: 'Sum',
        period: cdk.Duration.hours(24),
      });

      const failedAlarm = new cloudwatch.Alarm(
        this,
        `CodeBuildFailures-${proj.projectName}`,
        {
          alarmName: `infra-codebuild-daily-failures-${proj.projectName}`,
          metric: failedMetric,
          threshold:
            props.monitoringConfig.codeBuild.dailyFailedBuildsThreshold,
          evaluationPeriods: 1,
          comparisonOperator:
            cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          actionsEnabled: true,
        }
      );
      failedAlarm.addAlarmAction(
        new cloudwatch_actions.SnsAction(this.alarmTopic)
      );
    }
  }

  /**
   * ECS at max capacity — alert when RunningTaskCount stays at maxCapacity
   * for a sustained period, indicating prolonged scaling and cost increase.
   */
  private createEcsMaxCapacityAlarms(props: MonitoringStackProps): void {
    const periodsFor30Min = Math.ceil(
      props.monitoringConfig.ecsAutoScaling.maxCapacitySustainedMinutes / 5
    );

    for (const svc of props.ecsServices) {
      const metric = new cloudwatch.Metric({
        namespace: 'AWS/ECS',
        metricName: 'RunningTaskCount',
        dimensionsMap: {
          ClusterName: svc.clusterName,
          ServiceName: svc.serviceName,
        },
        statistic: 'Minimum',
        period: cdk.Duration.minutes(5),
      });

      const alarm = new cloudwatch.Alarm(
        this,
        `EcsAtMaxCapacity-${svc.projectName}-${svc.environment}`,
        {
          alarmName: `infra-ecs-at-max-capacity-${svc.projectName}-${svc.environment}`,
          metric,
          threshold: svc.maxCapacity,
          evaluationPeriods: periodsFor30Min,
          datapointsToAlarm: periodsFor30Min,
          comparisonOperator:
            cloudwatch.ComparisonOperator
              .GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          actionsEnabled: true,
        }
      );
      alarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.alarmTopic));
    }
  }

  /**
   * ElastiCache Redis — memory and CPU alarms.
   */
  private createElastiCacheAlarms(props: MonitoringStackProps): void {
    const clusterName = props.monitoringConfig.elastiCache.clusterName;

    // Memory
    const memoryMetric = new cloudwatch.Metric({
      namespace: 'AWS/ElastiCache',
      metricName: 'DatabaseMemoryUsagePercentage',
      dimensionsMap: { CacheClusterId: clusterName },
      statistic: 'Maximum',
      period: cdk.Duration.minutes(5),
    });

    const memoryAlarm = new cloudwatch.Alarm(this, 'ElastiCacheHighMemory', {
      alarmName: 'infra-elasticache-high-memory',
      metric: memoryMetric,
      threshold: props.monitoringConfig.elastiCache.memoryThresholdPercent,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      actionsEnabled: true,
    });
    memoryAlarm.addAlarmAction(
      new cloudwatch_actions.SnsAction(this.alarmTopic)
    );

    // CPU
    const cpuMetric = new cloudwatch.Metric({
      namespace: 'AWS/ElastiCache',
      metricName: 'EngineCPUUtilization',
      dimensionsMap: { CacheClusterId: clusterName },
      statistic: 'Maximum',
      period: cdk.Duration.minutes(5),
    });

    const cpuAlarm = new cloudwatch.Alarm(this, 'ElastiCacheHighCpu', {
      alarmName: 'infra-elasticache-high-cpu',
      metric: cpuMetric,
      threshold: props.monitoringConfig.elastiCache.cpuThresholdPercent,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      actionsEnabled: true,
    });
    cpuAlarm.addAlarmAction(
      new cloudwatch_actions.SnsAction(this.alarmTopic)
    );
  }

  /**
   * ALB consumed LCUs — alert when hourly LCU consumption spikes,
   * indicating unexpected traffic or misconfigured health checks.
   */
  private createAlbLcuAlarms(props: MonitoringStackProps): void {
    for (const entry of props.albs) {
      const metric = new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'ConsumedLCUs',
        dimensionsMap: {
          LoadBalancer: entry.alb.loadBalancerFullName,
        },
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      });

      const alarm = new cloudwatch.Alarm(
        this,
        `AlbHighLcu-${entry.name}`,
        {
          alarmName: `infra-alb-high-lcu-${entry.name}`,
          metric,
          threshold: props.monitoringConfig.alb.consumedLcuThreshold,
          evaluationPeriods: 1,
          comparisonOperator:
            cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          actionsEnabled: true,
        }
      );
      alarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.alarmTopic));
    }
  }

  /**
   * AWS Budget — monthly spend limit with alerts at configured thresholds.
   * Thresholds <= 100% use ACTUAL spend; > 100% use FORECASTED spend.
   */
  private createBudget(props: MonitoringStackProps): void {
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: 'infra-monthly-spend',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: {
          amount: props.monitoringConfig.budget.monthlyLimitUSD,
          unit: 'USD',
        },
      },
      notificationsWithSubscribers:
        props.monitoringConfig.budget.alertThresholds.map((threshold) => ({
          notification: {
            notificationType: threshold <= 100 ? 'ACTUAL' : 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            {
              subscriptionType: 'EMAIL',
              address: props.monitoringConfig.alarmEmail,
            },
          ],
        })),
    });
  }

  private sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-+|-+$/g, '');
  }
}
