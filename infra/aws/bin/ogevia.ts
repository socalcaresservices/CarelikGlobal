import { App } from "aws-cdk-lib";
import { buildOgeviaApp, resolveMode } from "../lib/app.js";
import { assertAccount, resolveEnvironment, resolveTestDatabase, resolveLiveTestBaseline } from "../lib/config.js";

// cdk-nag (AwsSolutions + HIPAA Security) is enforced by the unit tests via
// NagPack.validateScope(). It is not registered as a synth-time validation
// plugin: with aws-cdk-lib 2.272 / cdk-nag 3.0.2 the plugins are not invoked
// during `cdk synth`, so registering them here would only look like a control.

const app = new App();
const config = resolveTestDatabase(resolveLiveTestBaseline(resolveEnvironment(app.node.tryGetContext("env")), app.node.tryGetContext("liveTestBaseline")), app.node.tryGetContext("testDatabase"), app.node.tryGetContext("testMasterSecretArn"));
const approval = process.env.OGEVIA_DEPLOY_APPROVAL;
const mode = resolveMode(app.node.tryGetContext("mode"), approval);
assertAccount(config, process.env.CDK_DEFAULT_ACCOUNT);
// Optional, never committed: when set, the alarm topic gets one email subscription (see ObservabilityStack).
// Synthesize with `--output <temp dir>` when it is set, so the address is not written into the tracked infra/aws/cdk.out.
const alarmEmail = process.env.OGEVIA_ALARM_EMAIL?.trim() || undefined;
buildOgeviaApp(app, config, mode, approval, { alarmEmail });
