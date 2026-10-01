import { readFileSync } from "node:fs";
import { App } from "aws-cdk-lib";

// Same feature flags the CLI applies, so tests assert the template `cdk synth` emits.
const cdkJsonContext = (
  JSON.parse(readFileSync(new URL("../cdk.json", import.meta.url), "utf8")) as {
    context: Record<string, unknown>;
  }
).context;

export function newApp(): App {
  return new App({ context: cdkJsonContext });
}

export type CfnResource = {
  Type: string;
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
};
