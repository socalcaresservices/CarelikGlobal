// Prints the NON-SECRET production deployment parameters as JSON so
// deploy-production.sh has exactly one source of truth (lib/config.ts).
// Fails closed (non-zero) if the production configuration is invalid or would
// resolve to the test slice. Contains no secret values.
import { resolveEnvironment } from "../lib/config.js";
import { identityFunctionName } from "../lib/service-verification-api-stack.js";

const c = resolveEnvironment("prd");
const db = c.database;
if (db.purpose !== "production" || db.name !== "ogevia_prd" || !db.appLogin || !db.appSecretName) {
  throw new Error("Production configuration is not valid");
}
console.log(
  JSON.stringify({
    account: c.account,
    region: c.region,
    envName: c.envName,
    databaseName: db.name,
    appLogin: db.appLogin,
    appSecretName: db.appSecretName,
    testDatabaseName: c.testSlice.databaseName,
    testAppSecretArn: c.existing.appDatabaseSecretArn,
    rdsInstance: c.existing.databases.prod.instanceIdentifier,
    rdsHost: c.existing.databases.prod.endpointAddress,
    rdsMasterSecretArn: c.existing.databases.prod.masterSecretArn,
    appSecurityGroup: c.existing.securityGroups.prodApp,
    userPoolId: c.existing.cognitoUserPoolId,
    identityFunction: identityFunctionName(c),
    stacks: {
      secret: `Ogevia-${c.envName}-DatabaseSecret`,
      rest: [`Ogevia-${c.envName}-EvidenceStorage`, `Ogevia-${c.envName}-WebHosting`, `Ogevia-${c.envName}-ServiceVerificationApi`, `Ogevia-${c.envName}-Observability`],
      api: `Ogevia-${c.envName}-ServiceVerificationApi`,
      web: `Ogevia-${c.envName}-WebHosting`,
      egressOwner: "Ogevia-prod-NetworkEgress",
    },
  }),
);
