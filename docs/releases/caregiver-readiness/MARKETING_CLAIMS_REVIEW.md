# Review: "match score" claims against actual behaviour

Sources read: `apps/web/src/pages/marketing-page.tsx:23` (claim), `supabase/migrations/20260823080000_wire_real_availability_into_caregiver_matching.sql` (legacy CareScore),
the AWS matching in `infra/aws/db/migrations/0037`, `0043`. The legacy score is in the Supabase-era app; the AWS app has no CareScore.

**Claim:** "A real, computed match score between every caregiver and client - proximity, language, availability, skills, and shared visit history - not a guess."

| Part of the claim | What the code does (VERIFIED) | Supported? |
|---|---|---|
| "proximity" | Text equality: same ZIP = 30 pts, same city+state = 18, same state = 6, else 0. No distance. Missing address = 0 | **No** (not measured distance) |
| "availability" | 12 of 20 points are a *capacity proxy* (target hours minus scheduled hours; no target = 9); 8 points compare recorded windows, and **no recorded windows or no requested schedule = full 8** | **Partly**; missing data scores as perfect |
| "skills" | Tag equality; missing skills or no needs = full 10 | Partly; missing = perfect |
| "language" | Equality; no stated needs = full 25 | Partly |
| "shared visit history" | Up to 15 for completed visits together, minus 10 for an open incident | Yes |
| "not a guess" | Scores never gate on documents, service approval or availability; a caregiver with an expired CPR can score 91% | **No** |

**Conclusions.** The claim overstates proximity and treats missing inputs as perfect. The AWS release does not port those proxies. Any marketing line for the AWS product should
say only what is true: *"Caregivers are checked against approved hours, documents and conflicts first, then ranked with an explained, provisional score; missing information is shown as
incomplete."* Do not use "real/measured proximity" until a ZIP-centroid dataset with verified source, licence and vintage is loaded and the label is "Approx. distance".
The PR #76 review corrected the marketing page to: “Compare caregivers using explained matching factors. Missing information is clearly marked. Distance needs an approved location dataset, and mandatory assignment checks take effect when activated.” This describes the available release feature, not a claim that it is already deployed. The legacy test strings "91% match" in `schedule-page.test.tsx` describe the legacy score only.
