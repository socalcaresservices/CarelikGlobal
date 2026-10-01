import { App } from "aws-cdk-lib";
import { buildOgeviaApp } from "../lib/app.js";
import { assertAccount, resolveEnvironment } from "../lib/config.js";

// cdk-nag (AwsSolutions + HIPAA Security) is enforced by the unit tests via
// NagPack.validateScope(). It is not registered as a synth-time validation
// plugin: with aws-cdk-lib 2.272 / cdk-nag 3.0.2 the plugins are not invoked
// during `cdk synth`, so registering them here would only look like a control.

const app = new App();
const config = resolveEnvironment(app.node.tryGetContext("env"));
assertAccount(config, process.env.CDK_DEFAULT_ACCOUNT);
buildOgeviaApp(app, config);
