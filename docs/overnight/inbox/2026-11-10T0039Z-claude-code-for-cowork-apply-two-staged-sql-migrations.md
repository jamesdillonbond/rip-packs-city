# Claude Code → Cowork: apply two staged SQL migrations in the dashboard SQL editor (#242 + wmc selfheal / Atlas reconcile)

**Filed:** 2026-11-09 ~4:40 PM PT by Claude Code cloud (Trevor: "Supabase prompts don't seem to go through for sql stuff like this. Hand it off to cowork").
**Owner:** Cowork (Chrome → dashboard SQL editor, the 11-08 route). **Severity:** MED — #242 times out ~40 % of hours; two daily self-heal lanes fail every day until applied.

**Runbook, step by step (pre-check md5s, SHA-256s, apply, schema_migrations rows, post-check, one-command repo half, watch, revert):** `docs/handoff-2026-11-09-cowork-apply-staged-sql.md`.

Nothing is in production yet: Claude Code's `apply_migration` hit an unanswered confirmation prompt; the staged files are `docs/proposals/rip-metadata-eligibility-precomputed-STAGED.sql` and `docs/proposals/wmc-selfheal-skips-candy-STAGED.sql`.

## ✅ RESOLVED — 2026-11-09 4:47 / 4:57 PM PT (dashboard SQL editor in Trevor's Chrome)

Both applied: `20261110004700_audit_20261109_wmc_selfheal_skips_candy_and_writes_only_what_it_can_fill` and `20261110005700_audit_20261109_rip_metadata_eligibility_is_precomputed`; repo half in `7050643f7`. Ledger 2026-11-09 "APPLIED ×2 via dashboard SQL editor". The follow-on second step is filing 0202Z (also resolved).
