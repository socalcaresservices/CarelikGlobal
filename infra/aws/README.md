# @carelik/infra-aws

Ogevia AWS infrastructure (AWS CDK v2, TypeScript). See `CLAUDE.md` and `docs/aws/`.

**Nothing in this package has been deployed.** `cdk bootstrap`, `cdk deploy`, and `cdk import` are YELLOW actions (`CLAUDE.md` §13) and require explicit owner approval.

## Stacks

| Stack                            | Contents                                                                                                                                   | Status     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| `Ogevia-<stage>-EvidenceStorage` | KMS CMK (rotation on, retained), private SSE-KMS signature bucket (versioned, TLS-only, access-logged, retained), SSE-S3 access-log bucket | Synth only |

The manually created foundation (VPC, SGs, VPC endpoints, IAM role, RDS) is **deliberately not referenced**. It stays that way until a live read-only inventory verifies it (`docs/aws/CURRENT_AWS_INVENTORY.md`).

## Commands

```bash
pnpm --filter @carelik/infra-aws typecheck
pnpm --filter @carelik/infra-aws test            # CDK assertions + cdk-nag (AwsSolutions, HIPAA Security)
pnpm --filter @carelik/infra-aws exec cdk synth --quiet               # dev
pnpm --filter @carelik/infra-aws exec cdk synth --quiet -c stage=prod # prod (termination protection on)
```

`cdk diff` needs working AWS credentials and is read-only, but it has not been run yet (credentials were rejected).

## Security checks

cdk-nag is enforced in `test/evidence-storage-stack.test.ts` via `NagPack.validateScope()`. Removing a load-bearing acknowledgement makes the test fail; this was checked. cdk-nag is **not** registered as a synth-time validation plugin, because with aws-cdk-lib 2.272 / cdk-nag 3.0.2 the plugins produced no report entries during `cdk synth`.
