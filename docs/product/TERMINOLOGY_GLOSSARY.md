# Ogevia plain-language glossary (decision D7, 2026-10-14, approved in principle)

**Status: PROPOSED wording, applied only to screens that Wave 1 does not change. Compliance, authorization and billing meanings are unchanged.**
Rule: one word for one thing. Short line first; background behind "Details". Warnings and required instructions stay visible.

| Use | Meaning | Do not use for the same thing |
|---|---|---|
| **Visit** | Work that was actually done: a Time In and Time Out recorded by the server. | "Shift" |
| **Shift** | Work that is scheduled, with a start, end and caregiver (or open). | "Visit" |
| **Authorization** | The hours a payer approved for a client and service for a period; amendments are new versions. | "Approval" (that word is for billing and service approvals) |
| **Authorized** | The hours in the authorization. | |
| **Used** | Minutes already counted from visits (this is the word the caregiver screen uses; replaces "Serviced"). | "Serviced", "Consumed" |
| **Reserved** | Minutes held for shifts that are scheduled but not yet done. | "Scheduled hours" |
| **Left** | Authorized minus used minus other reserved minutes (definition D1; to be built). | "Remaining" on one screen and "Available" on another |
| **Billing ready** | The visit passed the automatic checks. It is not billed. | "Approved", "Billed" |
| **Approved for billing** | A person approved the minutes. It is not submitted. | "Billed" |
| **Caregiver** | A person on the Care Team who delivers service. | "Employee", "Worker" |
| **Assignment** | A caregiver is allowed to serve a client for a service. | "Shift" |
| **Report only** | A check is measured and shown but blocks nothing. | "Warning" |
| **Active** | A check blocks assignment or visit start. | "On" for readiness (Service checks keep their own On/Off words) |

Status of the words in the product today: "Used" is not yet applied on the caregiver Start screen, which Wave 1 changed (pending PR #87). Billing wording ("Approval is not submission", "Billing ready does not mean billed") is deliberately left verbatim.
