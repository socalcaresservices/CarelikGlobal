import { App, Tags } from "aws-cdk-lib";
import { OGEVIA_REGION, resolveStage } from "../lib/config.js";
import { EvidenceStorageStack } from "../lib/evidence-storage-stack.js";

// cdk-nag (AwsSolutions + HIPAA Security) is enforced by
// test/evidence-storage-stack.test.ts via NagPack.validateScope(). It is not
// registered as a synth-time validation plugin: with aws-cdk-lib 2.272 /
// cdk-nag 3.0.2 the plugins are not invoked during `cdk synth` (empty
// pluginReports in cdk.out/validation-report.json), so registering them here
// would only look like a control.

const app = new App();
const config = resolveStage(app.node.tryGetContext("stage"));

new EvidenceStorageStack(app, `Ogevia-${config.stage}-EvidenceStorage`, {
  config,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: OGEVIA_REGION,
  },
  description: `Ogevia ${config.stage} - private encrypted visit signature/evidence storage`,
});

Tags.of(app).add("project", "ogevia");
Tags.of(app).add("stage", config.stage);
Tags.of(app).add("managed-by", "cdk");
