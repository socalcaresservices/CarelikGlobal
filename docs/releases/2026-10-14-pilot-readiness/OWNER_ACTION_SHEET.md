# Owner action sheet

Two tasks remain, in this order (publishing the work branch is already done: PR #94 was merged to `main` as `12b5d4b`). **None of them changes any system.** Each says what to do, why, where, the exact buttons, what you should see, what to send back, and what not to touch.

---

## Already done: the work is on `main`

PR #94 (tests, scripts and documents only) was merged to `main` as `12b5d4b` after CI passed. Nothing was deployed. Nothing is needed from you here. If Netlify publishes every change merged to `main` automatically, it may have published this documents-and-scripts commit; there is no visible change to the public site.

---

## Task 1. Netlify: read four things and send screenshots (about 5 minutes)

1. **What:** look at four screens and send screenshots.
2. **Why:** to know (a) which version of the public site is live, (b) which sign-in system it uses, (c) whether every change merged to GitHub is published automatically, (d) whether `www.ogevia.com` and `app.ogevia.com` are the same site. These close blockers B-06, B-07, B-17 and give the facts for decision B-08.
3. **Where:** https://app.netlify.com/projects/carelikglobal (sign in as you normally do).
4. **Exact steps:**
   1. Left menu **Deploys**. Under **Production deploys**, screenshot the top three rows (the commit id, the "Published" time, the status).
   2. **Site configuration** → **Environment variables**. Find the row **`VITE_AUTH_PROVIDER`**. Screenshot **only that row** (name, which contexts it applies to, and its value). If there is no such row, write "not set". **Do not click, reveal or screenshot any other variable** (some hold keys).
   3. **Site configuration** → **Build & deploy** → **Continuous deployment**. Screenshot the part that shows the **production branch** and whether **auto publishing** is on. (On the Deploys page, a button "Stop auto publishing" means it is on.)
   4. **Site configuration** → **Domain management**. Screenshot the list of domains for this site (is `app.ogevia.com` in it?).
   5. *Optional, 1 minute, from any Windows computer:* open Command Prompt and type `nslookup app.ogevia.com`, press Enter, then `nslookup www.ogevia.com`. Copy the text each prints.
5. **Expect:** the top deploy is `63de403` or a later commit (`12b5d4b` if every merge to `main` publishes); `VITE_AUTH_PROVIDER` is "not set" or `supabase`; auto publishing is on; `www.ogevia.com` is in the list; `app.ogevia.com` is either in the list (same Netlify site) or points to an Amazon address (a different system).
6. **Send back:** the screenshots (and the optional text). They contain no passwords.
7. **Do not change anything:** do not press "Stop auto publishing", "Publish deploy", "Trigger deploy", "Lock" or "Clear cache"; do not edit or reveal any variable. What it tells me: if `VITE_AUTH_PROVIDER` says `cognito`, or anything other than not-set or `supabase`, that is a problem and I will tell you at once.

---

## Task 2. Name the AWS operator and authorize the read-only preflight

1. **What:** tell me who will run it (name and role) and write: "I authorize the read-only pilot preflight, including `--probe-lambda`."
2. **Why:** it is the only way to learn what is really running in the pilot: which stacks and code, whether the Wave 1 routes exist, backups and snapshots, and (through a few read-only calls with a synthetic test identity) which database generation is live and whether the test seed is present. Today none of this is known.
3. **Where:** AWS CloudShell (https://console.aws.amazon.com, region **us-west-2**, the administrator role), in a checkout of `main`.
4. **Exact commands for the operator** (nothing else):
   ```
   git clone https://github.com/socalcaresservices/CarelikGlobal.git   # skip if already cloned
   cd CarelikGlobal
   git fetch origin main
   git checkout main
   git pull --ff-only origin main
   git rev-parse HEAD     # expect 12b5d4b... or later
   bash infra/aws/slice/pilot-preflight-readonly.sh --probe-lambda
   ```
5. **Expect:** about two minutes of output, ending in either "No STOP items" or a list of STOP items, and the name of a folder it created in the operator's home directory.
6. **Send back:** the text of the file `SUMMARY.txt` in that folder (it prints no passwords, tokens or secret values), and the file `snapshots.txt`.
7. **Must not:** run anything else; read the database ledger (that needs your separate approval because it uses the database password); create a snapshot; change any security group or setting. The script is read-only and a test in the repository fails if it ever gains a write; if it stops with a STOP item, the operator changes nothing and sends the summary.

---

## What happens after you send these
I record the evidence in `BLOCKER_REGISTER.md` and the checklist. Then I put **one** question at a time to you, in the order in `RELEASE_DECISION_PACKAGE.md` section 4 (A before the preflight, B before any deployment, C before production). You are never asked to decide the C items before the pilot has results.
