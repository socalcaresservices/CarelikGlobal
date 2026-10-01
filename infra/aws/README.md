# @carelik/infra-aws

Ogevia AWS infrastructure: AWS CDK v2, TypeScript. This is the source of truth for AWS infrastructure (`CLAUDE.md` §6). See `docs/aws/PHASE_1_CDK_ARCHITECTURE.md`.

**Nothing in this package is deployed.** The account is not bootstrapped. `cdk bootstrap`, `cdk deploy` and `cdk import` are YELLOW actions (`CLAUDE.md` §13) and require explicit owner approval.

## Ownership model

|                                       | What                                                                                                                                                         | Where                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| A. EXISTING (reference only)          | VPC, 4 subnets, prod App/RDS SGs, admin SG, SSM endpoints, `ogevia-prod-postgres`, its master secret ARN, the app DB secret ARN, Cognito pool and app client | `lib/config.ts` (IDs), `lib/existing-foundation.ts` (handles; zero template resources) |
| B. FUTURE (synthesized, not deployed) | `Ogevia-prod-EvidenceStorage` (Phase 5), `Ogevia-prod-ServiceVerificationApi` (Phase 4), `Ogevia-prod-Observability` (Phase 4/7)                             | `lib/*-stack.ts`, wired in `lib/app.ts`                                                |
| C. DEFERRED (forbidden)               | NAT, VPC/subnets/SGs/endpoints, RDS, Aurora, ECS, EKS, OpenSearch, ElastiCache, new Cognito pool, Budgets, WAF …                                             | `lib/ownership.ts`                                                                     |

## Commands

```bash
pnpm --filter @carelik/infra-aws typecheck
pnpm --filter @carelik/infra-aws test        # CDK assertions, template scanner, cdk-nag AwsSolutions + HIPAA
pnpm --filter @carelik/infra-aws synth       # cdk synth -c env=prod -c mode=plan (no AWS calls needed)
pnpm --filter @carelik/infra-aws inventory -- ../../docs/aws/PHASE_1_SYNTH_INVENTORY.md   # after synth; exits 1 on violations
CDK_DISABLE_CLI_TELEMETRY=true pnpm --filter @carelik/infra-aws diff:template   # read-only; needs `aws sso login --profile ogevia-readonly`
```

Always diff with `--method=template` (the `diff:template` script). The CLI default `auto` method tries to **create a CloudFormation change set**, which is a write.

## Security checks

`lib/template-scan.ts` runs over every synthesized stack in the tests and in the inventory script. Each rule has a negative test. cdk-nag runs in the tests through `NagPack.validateScope()`. It is not a synth-time plugin, because with aws-cdk-lib 2.272 / cdk-nag 3.0.2 the plugins are not invoked during `cdk synth`.
