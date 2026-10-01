import { Duration, Stack, Validations, type StackProps } from "aws-cdk-lib";
import type * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as sns from "aws-cdk-lib/aws-sns";
import type { Construct } from "constructs";
import type { OgeviaEnvironmentConfig } from "./config.js";

export interface ObservabilityStackProps extends StackProps {
  readonly config: OgeviaEnvironmentConfig;
  readonly handler: lambda.IFunction;
  readonly api: apigw.IHttpApi;
}

/**
 * B. NEW FUTURE INFRASTRUCTURE - FUTURE/PLANNED (Phase 4/7).
 *
 * A small, fixed set of standard-resolution alarms (~$0.10 each per month).
 * Deliberately excluded: dashboards, detailed RDS monitoring, Performance
 * Insights, X-Ray, Contrib Insights, and third-party tools.
 *
 * RDS alarms read metrics of the EXISTING CloudFormation-owned instance by its
 * identifier. Reading metrics does not modify the instance.
 *
 * The SNS topic has no subscriptions: who gets paged, and how, is a Phase 7
 * owner decision. Alarm messages carry metric names and thresholds only.
 * NOT DEPLOYED.
 */
export class ObservabilityStack extends Stack {
  public readonly alarmTopic: sns.Topic;
  public readonly alarms: cloudwatch.Alarm[] = [];

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, {
      ...props,
      terminationProtection: props.config.terminationProtection,
    });
    const { config, handler, api } = props;
    const dbInstanceId = config.existing.databases.prod.instanceIdentifier;

    this.alarmTopic = new sns.Topic(this, "AlarmTopic", {
      displayName: `Ogevia ${config.envName} operational alarms`,
      enforceSSL: true,
    });
    Validations.of(this.alarmTopic).acknowledge({
      id: "HIPAA.Security-SNSEncryptedKMS",
      reason:
        "Alarm notifications carry metric names and thresholds only, never PHI. CloudWatch cannot publish to a topic using the AWS-managed SNS key, so encryption needs a customer-managed key: an owner cost decision.",
    });
    const notify = new cwActions.SnsAction(this.alarmTopic);

    const add = (
      id: string,
      metric: cloudwatch.IMetric,
      threshold: number,
      comparison: cloudwatch.ComparisonOperator,
      description: string,
      evaluationPeriods = 1,
    ) => {
      const alarm = new cloudwatch.Alarm(this, id, {
        metric,
        threshold,
        comparisonOperator: comparison,
        evaluationPeriods,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: description,
      });
      alarm.addAlarmAction(notify);
      this.alarms.push(alarm);
    };

    const fiveMinutes = { period: Duration.minutes(5) };
    const GT = cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD;
    const LT = cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD;

    add(
      "LambdaErrors",
      handler.metricErrors({ ...fiveMinutes, statistic: "Sum" }),
      1,
      GT,
      "Service Verification handler raised errors",
    );
    add(
      "LambdaThrottles",
      handler.metricThrottles({ ...fiveMinutes, statistic: "Sum" }),
      1,
      GT,
      "Service Verification handler was throttled",
    );
    add(
      "Api5xx",
      api.metricServerError({ ...fiveMinutes, statistic: "Sum" }),
      1,
      GT,
      "Service Verification API returned 5xx responses",
    );

    const rds = (metricName: string, statistic: string) =>
      new cloudwatch.Metric({
        namespace: "AWS/RDS",
        metricName,
        dimensionsMap: { DBInstanceIdentifier: dbInstanceId },
        statistic,
        ...fiveMinutes,
      });
    add(
      "RdsCpuHigh",
      rds("CPUUtilization", "Average"),
      80,
      GT,
      "Production PostgreSQL CPU >= 80% for 15 minutes",
      3,
    );
    // 2 GiB floor on a 20 GiB volume.
    add(
      "RdsFreeStorageLow",
      rds("FreeStorageSpace", "Minimum"),
      2 * 1024 ** 3,
      LT,
      "Production PostgreSQL free storage < 2 GiB",
    );
    // t4g.micro burst credits: sustained depletion means the class is too small.
    add(
      "RdsCpuCreditsLow",
      rds("CPUCreditBalance", "Minimum"),
      20,
      LT,
      "Production PostgreSQL CPU credit balance < 20",
      3,
    );
  }
}
