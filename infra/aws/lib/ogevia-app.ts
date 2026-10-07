import { App, Tags } from "aws-cdk-lib";
import { ApiStack } from "./api-stack.js";
import { AuthStack } from "./auth-stack.js";
import { loadConfig } from "./config.js";
import { DatabaseStack } from "./database-stack.js";
import { EvidenceStack } from "./evidence-stack.js";
import { ObservabilityStack } from "./observability-stack.js";

export function buildApp(app: App = new App()): App {
  const cfg = loadConfig(app);
  const env = { region: cfg.region, ...(app.node.tryGetContext("account") ? { account: String(app.node.tryGetContext("account")) } : {}) };
  const origins = String(app.node.tryGetContext("frontendOrigins") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const callbackUrls = origins.length ? origins.map((o) => `${o}/auth/callback`) : ["http://localhost:5173/auth/callback"];
  const allowedOrigins = origins.length ? origins : ["http://localhost:5173"];
  const p = `Ogevia-${cfg.stage}`;

  const evidence = new EvidenceStack(app, `${p}-Evidence`, cfg, { env });
  const db = new DatabaseStack(app, `${p}-Database`, cfg, { env, key: evidence.key });
  const auth = new AuthStack(app, `${p}-Auth`, cfg, { env, callbackUrls });
  const api = new ApiStack(app, `${p}-Api`, cfg, {
    env, vpc: db.vpc, subnets: db.subnets, lambdaSecurityGroup: db.lambdaSecurityGroup,
    db: db.instance, bucket: evidence.bucket, key: evidence.key, userPool: auth.userPool, client: auth.client, allowedOrigins,
  });
  const budget = app.node.tryGetContext("monthlyBudgetUsd");
  new ObservabilityStack(app, `${p}-Observability`, cfg, {
    env, fn: api.fn, db: db.instance, ...(budget ? { monthlyBudgetUsd: Number(budget) } : {}),
  });
  Tags.of(app).add("project", "ogevia");
  Tags.of(app).add("stage", cfg.stage);
  return app;
}
