# BAA readiness checklist (business associate agreements; not legal advice)

Date: 2026-11-27. A business associate agreement is a contract. **Whether one is required, who signs it and what it must say are legal decisions for the owner and counsel.** This list shows who touches Ogevia data, what to ask each, and what to record. Nothing here is a statement that a BAA is or is not in place.

## Parties and data paths
| Party | What they process in Ogevia | Needed? (counsel decides) | Evidence to obtain |
|---|---|---|---|
| **Amazon Web Services** | Hosts the database (RDS), evidence bucket (S3), API (Lambda/API Gateway), sign-in (Cognito), email (SES), logs (CloudWatch). Production data would live here. | Expected | Accepted AWS BAA (via AWS Artifact), account ID it covers, the list of covered services, and confirmation that every service in use (RDS, S3, KMS, Lambda, API Gateway, Cognito, SES, CloudWatch, CloudFront, Secrets Manager) is covered. |
| **SoCal Care Services (the agency) as Ogevia's customer** | The agency's own clients and caregivers. | Depends on how Ogevia and the agency are classified | Customer agreement and, if counsel says so, a BAA between the operating company and each agency customer. **Needed before the second agency.** |
| **Netlify** (legacy front-end host during migration) | Static web files; no database. Confirm no PHI is in builds or logs. | Counsel | Written confirmation of what data reaches it; retire when hosting moves. |
| **Supabase** (legacy reference system) | Old development data. Confirm it holds no real PHI before cancelling. | Counsel | Data inventory; deletion record at retirement. |
| **Email provider** | SES (AWS) only today. | Covered by the AWS BAA if SES is a covered service | Do not send PHI by email until confirmed. |
| **SMS provider (future)** | Phone numbers and shift times. | Yes, if used for anything beyond non-PHI | Not selected; the build uses a mock sender. Decide provider and BAA first. |
| **Payroll/billing handoff tools (future)** | Hours and identifiers. | Yes | Not integrated. |
| **Sandata / EVV (future)** | Visit data. | Per the payer/DDS requirements | Not integrated. |
| **Subcontractors** (developers, support, auditors) | Access to production only through the owner-approved process. | Yes if they can see PHI | List every person/vendor with production access; keep access minimal and time-limited. |

## Steps (in order)
1. Counsel confirms the classification of the operating company and each agency customer.
2. Accept the AWS BAA in the correct (production) account; save the PDF and the Artifact acceptance record outside the repository (do not commit account details).
3. Compare the covered-services list with the services in `docs/aws/CURRENT_AWS_INVENTORY.md`; anything not covered must not hold PHI.
4. Write the BAA register: party, service, data, date signed, renewal, contact, owner of the relationship.
5. Customer-facing: decide the standard BAA/agreement offered to agencies, the data-processing terms, subprocessor list and breach-notice terms. **Counsel.**
6. Add the gate to the release checklist: **no production PHI until steps 1–4 are recorded.**
7. Review the register each time a vendor is added, and yearly.

## What stays true until then
Production holds no real PHI before the gate; TEST uses synthetic data; alert emails carry no client details; no real client data goes into tickets, chats or screenshots.
