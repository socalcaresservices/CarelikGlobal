# AGENTS.md (read this first)

Instructions for any coding agent (Codex, Claude Code, others) working in this repository.

1. **`CLAUDE.md` is the authoritative project directive** (security, cost, approval gates, release process). Follow it. Its section 0 standing rules come first.
2. **Current work and handoff:** `docs/releases/2026-11-09-update-packet/HANDOFF.md` (state, branch, how to run tests) and `UPDATE_PACKET.md` (the full item list and the owner decisions still open).
3. **Do not deploy, apply migrations to any AWS database, change IAM, or push to `main`.** Those need the owner's explicit go-ahead (CLAUDE.md sections 0 and 13).
4. Use synthetic data only. No PHI in code, tests, prompts, or logs.
