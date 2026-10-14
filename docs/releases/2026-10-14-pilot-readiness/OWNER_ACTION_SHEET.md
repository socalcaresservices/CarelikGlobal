# Owner action sheet

Three tasks, in this order. **None of them changes any system.** Each says what to do, why, where, the exact buttons, what you should see, what to send back, and what not to touch.

---

## Task 1. Say yes or no to publishing the work branch (one word)

1. **What:** reply "approve push" (or "do not push"). I then push the branch `claude/pilot-readiness-closure` to GitHub and open a pull request for your review. I do not merge it.
2. **Why:** the AWS operator needs the read-only preflight script (Task 3), and it only exists on my local copy until it is pushed. The branch contains only tests, scripts and documents (file list in `RELEASE_DECISION_PACKAGE.md` section 5). It contains no secrets (scan result in the same section) and changes no application code, migration, API, seed, infrastructure or Netlify file.
3. **Where:** in this chat.
4. **Expect:** a pull request link from me. Merging is a separate decision.
5. **Send back:** "approve push".
6. **Do not:** merge it yourself before the checks pass; it publishes to www.ogevia.com the moment it is merged to `main` if Netlify auto-publishes (documents and scripts only, so no visible change, but you should know).

---

## Task 2. Netlify: read four things and send screenshots (about 5 minutes)

1. **What:** look at four screens and send screenshots.
2. **Why:** to know (a) which version of the public site is live, (b) which sign-in system it uses, (c) whether every change merged to GitHub is published automatically, (d) whether `www.ogevia.com` and `app.ogevia.com` are the same site. These close blockers B-06, B-07, B-17 and give the facts for decision B-08.
3. **Where:** https://app.netlify.com/projects/carelikglobal (sign in as you normally do).
4. **Exact steps:**
   1. Left menu **Deploys**. Under **Production deploys**, screenshot the top three rows (the commit id, the "Published" time, the status).
   2. **Site configuration** → **Environment variables**. Find the row **`VITE_AUTH_PROVIDER`**. Screenshot **only that row** (name, which contexts it applies to, and its value). If there is no such row, write "not set". **Do not click, reveal or screenshot any other variable** (some hold keys).
   3. **Site configuration** → **Build & deploy** → **Continuous deployment**. Screenshot the part that shows the **production branch** and whether **auto publishing** is on. (On the Deploys page, a button "Stop auto publishing" means it is on.)
   4. **Site configuration** → **Domain management**. Screenshot the list of domains for this site (is `app.ogevia.com` in it?).
   5. *Optional, 1 minute, from any Windows computer:* open Command Prompt and type `nslookup app.ogevia.com`, press Enter, then `nslookup www.ogevia.com`. Copy the text each prints.
5. **Expect:** the top deploy is `63de403` or a later commit (`484135d` if every merge publishes); `VITE_AUTH_PROVIDER` is "not set" or `supabase`; auto publishing is on; `www.ogevia.com` is in the list; `app.ogevia.com` is either in the list (same Netlify site) or points to an Amazon address (a different system).
6. **Send back:** the screenshots (and the optional text). They contain no passwords.
7. **Do not change anything:** do not press "Stop auto publishing", "Publish deploy", "Trigger deploy", "Lock" or "Clear cache"; do not edit or reveal any variable. What it tells me: if `VITE_AUTH_PROVIDER` says `cognito`, or anything other than not-set or `supabase`, that is a problem and I will tell you at once.

---

## Task 3. Name the AWS operator and authorize the read-only preflight

1. **What:** tell me who will run it (name and role) and write: "I authorize the read-only pilot preflight, including `--probe-lambda`."
2. **Why:** it is the only way to learn what is really running in the pilot: which stacks and code, whether the Wave 1 routes exist, backups and snapshots, and (through a few read-only calls with a synthetic test identity) which database generation is live and whether the test seed is present. Today none of this is known.
3. **Where:** AWS CloudShell (https://console.aws.amazon.com, region **us-west-2**, the administrator role), in a checkout of the branch from Task 1.
4. **Exact commands for the operator** (nothing else):
   ```
   git fetch origin claude/pilot-readiness-closure
   git checkout claude/pilot-readiness-closure
   bash infra/aws/slice/pilot-preflight-readonly.sh --probe-lambda
   ```
5. **Expect:** about two minutes of output, ending in either "No STOP items" or a list of STOP items, and the name of a folder it created in the operator's home directory.
6. **Send back:** the text of the file `SUMMARY.txt` in that folder (it prints no passwords, tokens or secret values), and the file `snapshots.txt`.
7. **Must not:** run anything else; read the database ledger (that needs your separate approval because it uses the database password); create a snapshot; change any security group or setting. The script is read-only and a test in the repository fails if it ever gains a write; if it stops with a STOP item, the operator changes nothing and sends the summary.

---

## What happens after you send these
I record the evidence in `BLOCKER_REGISTER.md` and the checklist. Then I put **one** question at a time to you, in the order in `RELEASE_DECISION_PACKAGE.md` section 4 (A before the preflight, B before any deployment, C before production). You are never asked to decide the C items before the pilot has results.
