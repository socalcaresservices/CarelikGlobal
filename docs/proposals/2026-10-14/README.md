# Proposals awaiting approval (2026-10-14)

Each item below is **a proposal only: nothing here is built, applied or deployed.** They follow the owner's decisions D1, D3, D4 and D5 of 2026-10-14 ("prepare as separate proposals requiring explicit approval before implementation").

| # | Proposal | Needs approval for | Depends on |
|---|---|---|---|
| 1 | [Authorization position: one calculation, four words](01-authorization-position-api.md) (D1) | New server function, additive API fields, screen changes | PR #88 (0052) and PR #87 |
| 2 | [Scheduling preference: Not set, Fixed, Flexible, Mixed](02-scheduling-preference-migration.md) (D3) | One small migration (0053) | Owner running the read-only data check |
| 3 | [Document reminders: in-app design, and the email/SMS assessment](03-document-reminders-design.md) (D4) | In-app build; separately, any AWS service | In-app: none. Email/SMS: your architecture, cost and security sign-off |
| 4 | [Agency working-hour limits](04-working-hour-limits-design.md) (D5) | The rule definitions and enforcement behavior | Your confirmation of the defaults and of how hours are counted |

Already built and open for review (separate PRs): the accounting fix [#88](https://github.com/socalcaresservices/CarelikGlobal/pull/88) (migration 0052) and the UI-only changes [#89](https://github.com/socalcaresservices/CarelikGlobal/pull/89).

Migration order if all are approved: 0047 to 0049 (release plan), 0050 and 0051 (Wave 1, #87), 0052 (#88), 0053 (scheduling preference), then 0054 and later (reminders, work-hour rules).
