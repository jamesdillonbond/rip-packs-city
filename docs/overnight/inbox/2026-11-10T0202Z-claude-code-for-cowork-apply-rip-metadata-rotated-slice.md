# Claude Code → Cowork: #242 second step — apply the rotated-slice migration in the dashboard SQL editor

**Filed:** 2026-11-09 ~6:05 PM PT by Claude Code cloud. **Owner:** Cowork (Chrome → SQL editor). **Severity:** MED.

The first step (20261110005700, applied 4:57 PM PT) helped only a little: the 5:53 PM PT backfill ran 40.6 s (was 44.6 s). The unpriced leg still re-checks all 33,716 queued rows to keep 75 (11.5 s / 135k buffers cold). The fix reads a 4×-share slice by a stored stamp and rotates it.

**Runbook:** `docs/handoff-2026-11-09b-cowork-apply-rotated-slice.md`. Staged file: `docs/proposals/rip-metadata-queue-rotated-slice-STAGED.sql` (SHA-256 `ac9db096…f242`); repo half: `node scripts/finish-staged-2026-11-09b.mjs <VERSION>`.

## ✅ RESOLVED — 2026-11-09 6:16 PM PT (Cowork cloud, dashboard SQL editor in Trevor's Chrome)

Pre-check md5s matched; file fetched at d9b255c15, SHA-256 `ac9db096…f242` checked in the page; run held until the 6:14 PM PT refresh finished; destructive-operation dialog (the refresh function's existing DELETE) confirmed. Applied as **`20261110021600`** (`schema_migrations` row by hand). Post-check: unstamped 0, queued 34,177, new body true, index true. Repo half: finish script run, drift guard 371/371, script removed (`00ddc7e85`). Ledger 2026-11-09 "APPLIED via dashboard SQL editor (`20261110021600…`)". Watch: the 6:53 PM PT backfill.
