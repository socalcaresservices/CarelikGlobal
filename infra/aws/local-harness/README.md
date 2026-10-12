# Local harness: run the AWS web app in your own browser

For development and demos only. Everything is synthetic. Nothing here is deployed, touches AWS, or is used by any deployed code.

It runs, on your computer:
- the **real AWS web app** (`apps/web`, the Cognito build),
- the **real API handler** (`apps/sv-api`) on a **local PostgreSQL** with all migrations applied by the real runner,
- a **stand-in sign-in service**: you pick a synthetic person, there is no password.

Everything is served from one address, `https://localhost`. (The app only accepts a sign-in domain that is an https origin without a port, so the harness uses port 443.)

## Requirements
- Node 22 and pnpm 9.15.4 (`corepack enable`, then `pnpm install --frozen-lockfile` at the repository root)
- A PostgreSQL 16 or newer **on this computer**, with a superuser (the migrations create roles and the `btree_gist` extension)
- `openssl` on your PATH (creates the local certificate). Or make a trusted one with mkcert and set `HARNESS_CERT` and `HARNESS_KEY`
- Permission to listen on port 443 (see below)

### PostgreSQL in one command (Docker)
```bash
docker run -d --name ogevia-harness-pg -e POSTGRES_PASSWORD=harness -p 5432:5432 postgres:16
export HARNESS_ADMIN_URL=postgres://postgres:harness@127.0.0.1:5432/postgres
```
Without Docker, point `HARNESS_ADMIN_URL` at any local superuser URL. Default: `postgres://postgres@127.0.0.1:5432/postgres`. The harness refuses any database that is not on this computer.

## Run it
From the repository root:
```bash
pnpm install --frozen-lockfile
pnpm --filter @carelik/infra-aws harness:setup   # creates and seeds database "ogevia_local_harness" (drops it first)
pnpm --filter @carelik/infra-aws harness:build   # builds the web app (about 20 s; repeat after changing the web code)
pnpm --filter @carelik/infra-aws harness:serve   # starts https://localhost
```
Open **https://localhost**. The browser warns about the certificate (a local self-signed one): choose *Advanced*, then *Proceed to localhost*. Click **Sign in** and pick a person.

Run `harness:setup` again at any time to reset the data.

## Port 443
- macOS and Windows: works as a normal user.
- Linux: allow unprivileged use of low ports once, then run as yourself:
  `sudo sysctl -w net.ipv4.ip_unprivileged_port_start=443`
  or run the serve command with `sudo`, or `sudo setcap 'cap_net_bind_service=+ep' "$(command -v node)"`.

## The people (no passwords)
| Person | Role | Try |
|---|---|---|
| Olivia Owner | Administrator | Home with dollar values, Billing review, Accounts, settings |
| Morgan Manager | Manager | Operations without dollar values |
| Sam Scheduler | Scheduler | Schedule |
| Alex Caregiver | Caregiver | Verify visit: start, end, confirm (use a phone-sized window) |
| Blair Caregiver | Caregiver | Has a visit from 20 hours ago that was never closed |

## Seeded demo data ("Local Demo Agency (synthetic)")
- 7 clients (`Demo Vega`, `Demo Okafor`, ...), two services (Respite, Personal care), 4 caregivers (2 can sign in).
- `Vega`: about 80% used plus scheduled shifts (near limit). `Tanaka`: authorization ends in 10 days. `Brightwater`: expired. `Nakamura`: no authorization. `Lindqvist`: no rate. `Rivera (late confirmation)`: a late confirmation was accepted for a shift-linked visit (shows the F1 fix: hours left count it once).
- Action Needed has real items: an unclosed visit, a visit in review, open shifts (one starts within 48 hours), a called-out shift, visits ready for approval.
- Seeded signatures have no image (the harness keeps evidence in memory only).

## How it differs from a real deployment
- **No real authentication.** The stand-in issues tokens signed with a key that exists only in the running process. Only this harness accepts them. The API Gateway authorizer is not present; the handler's own claim checks are.
- Uploaded files, signatures and invitations are kept in memory and are lost when you stop the server. No email or SMS is sent.
- The server listens on `127.0.0.1` only. Never expose it, and never point it at a real database.
- The banner "TEST — synthetic data only" is shown on purpose (`VITE_APP_ENV=development`).

## Files
`setup.ts` database and seed, `build-web.ts` web build, `serve.ts` the server, `common.ts` constants. Certificates and the web build are written to `local-harness/.local/` (git-ignored).
