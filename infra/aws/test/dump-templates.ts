// Dumps the synthesized templates of production (and the shared NetworkEgress) as compact JSON, for the authentication-separation gate.
//   cd infra/aws && npx tsx test/dump-templates.ts <output dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { Template } from "aws-cdk-lib/assertions";
import { buildOgeviaApp } from "../lib/app.js";
import { ENVIRONMENTS } from "../lib/config.js";
import { newApp } from "./helpers.js";

const out = process.argv[2];
if (!out) throw new Error("usage: tsx test/dump-templates.ts <output dir>");
mkdirSync(out, { recursive: true });
for (const env of ["prd", "prod"] as const) {
  for (const p of buildOgeviaApp(newApp(), ENVIRONMENTS[env], "plan")) {
    const name = p.stack.stackName;
    if (env === "prod" && name !== "Ogevia-prod-NetworkEgress") continue;
    writeFileSync(`${out}/${name}.json`, JSON.stringify(Template.fromStack(p.stack).toJSON()));
  }
}
console.log("dumped", out);
