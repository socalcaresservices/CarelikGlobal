import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cw from "aws-cdk-lib/aws-cloudwatch";
import * as cwa from "aws-cdk-lib/aws-cloudwatch-actions";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import type * as rds from "aws-cdk-lib/aws-rds";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";
import type { OgeviaConfig } from "./config.js";

export interface ObservabilityStackProps extends StackProps {
  fn: lambda.IFunction;
  db: rds.IDatabaseInstance;
  /** Monthly cost budget in USD; no default (owner sets it). */
  monthlyBudgetUsd?: number;
}

export class ObservabilityStack extends Stack {
  constructor(scope: Construct, id: string, cfg: OgeviaConfig, props: ObservabilityStackProps) {
    super(scope, id, props);
    const topic = new sns.Topic(this, "Alarms", { enforceSSL: true });
    if (cfg.alarmEmail) topic.addSubscription(new subs.EmailSubscription(cfg.alarmEmail));
    const action = new cwa.SnsAction(topic);
    const alarms = [
      props.fn.metricErrors({ period: Duration.minutes(5) }).createAlarm(this, "LambdaErrors", {
        threshold: 1, evaluationPeriods: 1, treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }),
      props.db.metricCPUUtilization().createAlarm(this, "DbCpu", { threshold: 80, evaluationPeriods: 3 }),
      props.db.metricFreeStorageSpace().createAlarm(this, "DbStorage", {
        threshold: 2 * 1024 ** 3, evaluationPeriods: 1, comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
      }),
    ];
    for (const a of alarms) a.addAlarmAction(action);

    if (props.monthlyBudgetUsd && cfg.alarmEmail) {
      new budgets.CfnBudget(this, "MonthlyBudget", {
        budget: {
          budgetName: `ogevia-${cfg.stage}-monthly`,
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: { amount: props.monthlyBudgetUsd, unit: "USD" },
        },
        notificationsWithSubscribers: [80, 100].map((t) => ({
          notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: t, thresholdType: "PERCENTAGE" },
          subscribers: [{ subscriptionType: "EMAIL", address: cfg.alarmEmail as string }],
        })),
      });
    }
  }
}
