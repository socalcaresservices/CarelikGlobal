import { Template } from "aws-cdk-lib/assertions";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildOgeviaApp } from "../lib/app.js";
import { assertDatabaseConfig, ENVIRONMENTS, ISOLATED_TEST_TARGET, resolveTestDatabase, resolveLiveTestBaseline } from "../lib/config.js";
import { loadMigrations } from "../db/scripts/migrations.js";
import { newApp } from "./helpers.js";

const MASTER = "arn:aws:secretsmanager:us-west-2:300094796789:secret:rds!db-11111111-2222-3333-4444-555555555555-AbCdEf";
const isolated = () => resolveTestDatabase(ENVIRONMENTS.prod, "isolated", MASTER);
const templates = (config: typeof ENVIRONMENTS.prod, context: Record<string, unknown> = {}) => {
  const app = newApp();
  for (const [key, value] of Object.entries(context)) app.node.setContext(key, value);
  return Object.fromEntries(buildOgeviaApp(app, config).map(({ stack }) => [stack.stackName, Template.fromStack(stack).toJSON()])) as Record<string, any>;
};
describe("isolated TEST database candidate", () => {
  it("is opt-in, refuses production/unknown choices and wrong master metadata", () => {
    expect(resolveTestDatabase(ENVIRONMENTS.prod, undefined)).toBe(ENVIRONMENTS.prod);
    for (const choice of ["typo", true]) expect(() => resolveTestDatabase(ENVIRONMENTS.prod, choice, MASTER)).toThrow();
    expect(() => resolveTestDatabase(ENVIRONMENTS.prd, "isolated", MASTER)).toThrow(/only/);
    for (const arn of [undefined, "password", ENVIRONMENTS.prd.existing.databases.prod.masterSecretArn]) expect(() => resolveTestDatabase(ENVIRONMENTS.prod, "isolated", arn)).toThrow(/ARN/);
    const config = isolated();
    expect(config.existing.databases.prod.endpointAddress).toBe(ISOLATED_TEST_TARGET.endpointAddress);
    expect(config.features.staffDuplicates).toBe(false);
    expect(() => assertDatabaseConfig({ ...config, database: { ...config.database, appLogin: "ogevia_prd_app" } })).toThrow(/reviewed target/);
  });
  it("production configuration and every production template stay unchanged", () => {
    const before = templates(ENVIRONMENTS.prd);
    const values = JSON.stringify(ENVIRONMENTS);
    templates(isolated());
    expect(JSON.stringify(ENVIRONMENTS)).toBe(values);
    expect(templates(ENVIRONMENTS.prd)).toEqual(before);
  }, 120000);
  it("changes only the TEST API, additive shared endpoint policy, and new retained TEST secret stack", () => {
    const baseline = templates(resolveLiveTestBaseline(ENVIRONMENTS.prod, "0102")), next = templates(isolated());
    expect(Object.keys(next).filter((name) => !baseline[name])).toEqual(["Ogevia-prod-DatabaseSecret"]);
    for (const name of Object.keys(baseline).filter((name) => !/ServiceVerificationApi|NetworkEgress|Observability/.test(name))) expect(next[name], name).toEqual(baseline[name]);
    const expectedAlarms = structuredClone(baseline["Ogevia-prod-Observability"]);
    for (const resource of Object.values<any>(expectedAlarms.Resources)) {
      for (const dimension of resource.Properties?.Dimensions ?? []) {
        if (dimension.Name === "DBInstanceIdentifier") dimension.Value = ISOLATED_TEST_TARGET.instanceIdentifier;
      }
    }
    expect(next["Ogevia-prod-Observability"]).toEqual(expectedAlarms);
    const api = next["Ogevia-prod-ServiceVerificationApi"].Resources;
    const handler = Object.entries<any>(api).find(([id, r]) => id.startsWith("Handler") && r.Type === "AWS::Lambda::Function")![1];
    expect(handler.Properties.Environment.Variables.DB_HOST).toBe(ISOLATED_TEST_TARGET.endpointAddress);
    expect(handler.Properties.Environment.Variables.DB_NAME).toBe("ogevia_sv_test");
    expect(Object.values<any>(api).filter((r) => r.Type === "AWS::ApiGatewayV2::Route")).toHaveLength(259);
    expect(Object.values<any>(api).filter((r) => r.Type === "AWS::EC2::SecurityGroupIngress")).toEqual([expect.objectContaining({ Properties: expect.objectContaining({ GroupId: ISOLATED_TEST_TARGET.securityGroupId, FromPort: 5432, ToPort: 5432, SourceSecurityGroupId: ENVIRONMENTS.prod.existing.securityGroups.prodApp }) })]);
    expect(Object.values<any>(api).some((r) => /AWS::RDS::DBInstance|AWS::RDS::DBCluster/.test(r.Type))).toBe(false);
    const oldResources = baseline["Ogevia-prod-NetworkEgress"].Resources, newResources = next["Ogevia-prod-NetworkEgress"].Resources;
    for (const id of Object.keys(oldResources)) {
      if (JSON.stringify(oldResources[id]) === JSON.stringify(newResources[id])) continue;
      expect(oldResources[id].Type).toBe("AWS::EC2::VPCEndpoint");
      const old = structuredClone(oldResources[id]), changed = structuredClone(newResources[id]);
      const statement = (r: any) => r.Properties.PolicyDocument.Statement.find((s: any) => s.Action === "secretsmanager:GetSecretValue" || s.Action?.includes?.("secretsmanager:GetSecretValue"));
      const prior = statement(old).Resource;
      expect(statement(changed).Resource).toEqual([...prior, expect.stringContaining("ogevia/test/database/app-")]);
      statement(changed).Resource = prior;
      expect(changed).toEqual(old);
    }
    const secret = Object.values<any>(next["Ogevia-prod-DatabaseSecret"].Resources).find((r) => r.Type === "AWS::SecretsManager::Secret");
    expect(secret).toMatchObject({ DeletionPolicy: "Retain", Properties: { Name: ISOLATED_TEST_TARGET.appSecretName, GenerateSecretString: { SecretStringTemplate: JSON.stringify({ username: "ogevia_test_app", dbname: "ogevia_sv_test" }) } } });
    const dir = mkdtempSync(join(tmpdir(), "ogevia-isolation-gate-"));
    try {
      for (const [name, assembly] of [["shared", baseline], ["isolated", next]] as const) {
        mkdirSync(join(dir, name));
        for (const [stack, template] of Object.entries(assembly)) writeFileSync(join(dir, name, `${stack}.template.json`), JSON.stringify(template));
      }
      const invoke = (args: string[]) => spawnSync("bash", ["-c", 'python3 "$@"', "gate", fileURLToPath(new URL("../../../docs/releases/2026-11-10-ux-redesign-test/toolchain/diff_gate_ux.py", import.meta.url)).replaceAll("\\", "/"), ...args], { encoding: "utf8" });
      const gate = () => invoke(["--isolated-assemblies", join(dir, "shared"), join(dir, "isolated")]);
      const pass = gate();
      expect(pass.status, pass.stdout + pass.stderr).toBe(0);
      // Reproduce the actual live 0102 template shape: six retained routes and
      // manually packaged code parameters, before the three pending UX routes.
      const live = structuredClone(baseline["Ogevia-prod-ServiceVerificationApi"]);
      const additions = new Set(["POST /v1/caregivers/{caregiverRecordId}/signin-override", "GET /v1/signin-overrides", "POST /v1/imports/{kind}"]);
      for (const [id, resource] of Object.entries<any>(live.Resources)) if (additions.has(resource.Properties?.RouteKey)) delete live.Resources[id];
      live.Resources.Handler886CB40B.Properties.Code = { S3Bucket: { Ref: "RepairCodeBucket" }, S3Key: { Ref: "RepairCodeKey" } };
      live.Resources.Handler886CB40B.Metadata = { ...live.Resources.Handler886CB40B.Metadata, "aws:asset:path": "accepted-0102.zip" };
      writeFileSync(join(dir, "live.json"), JSON.stringify(live));
      const compare = (file: string) => invoke(["--live", join(dir, "live.json"), "--new", file, "--expect", "pre"]);
      const pre = compare(join(dir, "shared", "Ogevia-prod-ServiceVerificationApi.template.json"));
      expect(pre.status, pre.stdout + pre.stderr).toBe(0);
      const removedRoute = structuredClone(baseline["Ogevia-prod-ServiceVerificationApi"]);
      delete removedRoute.Resources.QrCheckinPost0102;
      writeFileSync(join(dir, "bad-api.json"), JSON.stringify(removedRoute));
      expect(compare(join(dir, "bad-api.json")).status).toBe(1);
      // Removing a production grant from the shared endpoint must fail closed.
      const damaged = structuredClone(next["Ogevia-prod-NetworkEgress"]);
      damaged.Resources.SecretsManagerEndpoint5E83C66B.Properties.PolicyDocument.Statement[0].Resource.splice(1, 1);
      writeFileSync(join(dir, "isolated", "Ogevia-prod-NetworkEgress.template.json"), JSON.stringify(damaged));
      expect(gate().status).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120000);
  it("keeps the released migration set unchanged and records the explicit UX set with withdrawn 0089 absent", () => {
    expect(loadMigrations()).toHaveLength(88);
    const ux = loadMigrations({ includePendingUx: true });
    expect(ux).toHaveLength(107);
    expect(ux.slice(-5).map((m) => m.version)).toEqual(["0103", "0104", "0105", "0106", "0107"]);
    expect(ux.find((m) => m.version === "0089")?.name).toBe("0089_manager_record_missing_visit.sql");
  });
  it("retains all six live route IDs, the NoEcho QR reference and reviewed metadata without accepting a literal key", () => {
    const baseline = resolveLiveTestBaseline(ENVIRONMENTS.prod, "0102");
    const spec = { Type: "String", NoEcho: true, AllowedPattern: "[0-9a-fA-F]{64}", Description: "Existing TEST QR key" };
    const tags = [{ Key: "environment", Value: "prod" }, { Key: "project", Value: "ogevia" }];
    const t = templates(baseline, { liveQrParameterSpec: JSON.stringify(spec), liveTestHandlerTags: JSON.stringify(tags) })["Ogevia-prod-ServiceVerificationApi"];
    expect(t.Parameters.ClientQrEncryptionKey).toEqual(spec);
    expect(t.Parameters.RepairCodeBucket).toEqual({ Type: "String" });
    expect(t.Parameters.RepairCodeKey).toEqual({ Type: "String" });
    expect(t.Resources.Handler886CB40B.Properties.Environment.Variables.OGEVIA_QR_ENCRYPTION_KEY).toEqual({ Ref: "ClientQrEncryptionKey" });
    expect(t.Resources.Handler886CB40B.Properties.Tags).toEqual(tags);
    const retained = {
      ApiGETv1reportsmissingvisits700E9FA8: "GET /v1/reports/missing-visits",
      ApiPOSTv1shiftsshiftIdmissingvisit38D35A82: "POST /v1/shifts/{shiftId}/missing-visit",
      BusinessDocumentsGet0095: "GET /v1/business-documents", BusinessDocumentsPost0095: "POST /v1/business-documents",
      QrCheckinPost0102: "POST /v1/checkin", ClientQrCardPost0102: "POST /v1/clients/{clientId}/qr-card",
    };
    for (const [id, key] of Object.entries(retained)) expect(t.Resources[id].Properties).toMatchObject({ RouteKey: key, AuthorizationType: "JWT" });
    expect(() => templates(baseline, { liveQrParameterSpec: { ...spec, Default: "a".repeat(64) } })).toThrow(/without an embedded key/);
    expect(() => resolveLiveTestBaseline(ENVIRONMENTS.prd, "0102")).toThrow(/TEST-only/);
  }, 120000);
});
