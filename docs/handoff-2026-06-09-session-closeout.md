# Handoff 2026-06-09 — session close-out (one ledger residual + doc sweep)

The 2026-06-08/09 Cowork session is essentially fully drained — the audit-followups, verified-wallet security, HybridCustody verify build, Pinnacle FMV retirement, Pinnacle listings/concierge fix, brand-token Phase-2, and the remaining-cleanups handoffs all shipped (commits through `57b3def` + the git-push enablement). This doc captures the only items that slipped through.

## 1. Missing ledger entry (the one real action)

`audit_20260608_revoke_inert_writes_sensitive_tables` was shipped live by Cowork during the security-sibling sweep but never made it into a handoff, so it's **not** in `docs/overnight/ledger.md` (verified missing; the other three 06-09 migrations are present). Add a Shipped-block entry:

- **What:** defense-in-depth — revoked `INSERT, UPDATE, DELETE, TRUNCATE` from `anon, authenticated` on 8 security-sensitive tables that are already service_role-only by RLS policy (so the grants were inert; this just removes them so a future policy drift can't expose them). Tables: `pro_users`, `pro_payment_log`, `stripe_payment_log`, `feature_quotas`, `deny_list`, `seeded_wallets`, `mcp_api_keys`, `linked_accounts` (the last is the HybridCustody verify path's source of truth, so it's the most important to keep locked). Extends the `saved_wallets` fix to the rest of the escalation-relevant tables.
- **Revert:** `GRANT INSERT, UPDATE, DELETE, TRUNCATE ON public.pro_users, public.pro_payment_log, public.stripe_payment_log, public.feature_quotas, public.deny_list, public.seeded_wallets, public.mcp_api_keys, public.linked_accounts TO anon, authenticated;`
- **Note:** the related `saved_wallets` revoke (`audit_20260608_close_verified_wallet_selfwrite_holes`) and the backup-table lock (`audit_20260609_lock_pinnacle_backup_and_rewards_tier_search_path`) ARE already logged — this is just their sibling.

## 2. Doc sweep (likely auto-handled now)

A few session docs may be uncommitted — primarily `docs/operations/nightly-pass-git-push-setup.md` (new) and possibly stray `docs/overnight/inbox/*` files. **The nightly autonomous pass can now push (PAT wired + verified 2026-06-09), so it will sweep these into a commit on its next run** — no manual action needed unless you want them in sooner, in which case `git add` them by exact path and commit.

## Context worth carrying (already done, do NOT redo)
- Nightly-pass git push is live: fine-grained PAT in the push URL, dry-run `Everything up-to-date` confirmed. Expires **Sep 7, 2026** — rotation reminder is in `docs/operations/nightly-pass-git-push-setup.md` + flagged for the quarterly check.
- Security posture clean: `check_public_security_invariants()` empty, 0 trust-health breaches, the verified-wallet gate closed across all four `verified_at` writers.
- Pinnacle FMV fully on the per-render spine; legacy table + all writers + the orphaned `pinnacle_fmv_recalc(text)` retired; ASK freshness now in `v_rpc_trust_health` (`pinnacle_ask_stale_hours`).

GUARDRAILS: direct-to-main, no branches/PRs. The ledger edit is the only required action; everything else is already shipped or auto-handled.

---

## Addendum — 2026-06-09 PM Cowork follow-up (cron + watchlist; CRON-DROP-WAVE resolution)

Investigated the queued PINNACLE-RECONCILE-TIMEOUT breach + CRON-DROP-WAVE. Root cause was cron-job.org AUTO-DISABLING entries after consecutive 500s during the 05-08:30Z DB-saturation window, NOT ongoing saturation. Actions taken (operator-class, Trevor present):

- DB (live via MCP) migration `audit_20260609_watchlist_pinnacle_listing_cache_and_pinnacle_sync` then corrected by `audit_20260609_unwatchlist_retired_pinnacle_listing_cache`: net result = added `pinnacle-sync` @1560m/medium to `pipeline_cadence_watchlist` (PIN-SYNC-CRON gate met: 10:07Z tick ok=true post-5880eeb). pinnacle-listing-cache was NOT watchlisted (it was deliberately retired today — route+cron+health-map all gone). Revert: `DELETE FROM pipeline_cadence_watchlist WHERE pipeline='pinnacle-sync';`
- cron-job.org (Chrome console): re-enabled the auto-disabled `pinnacle-listings-reconcile` entry (job 7589136) + test-ran it (200 OK, 2.05s) -> wrote fresh asks, `pinnacle_ask_stale_hours` 19h -> 0.01h, trust-health BREACH cleared. Test-ran `Recalc Ultimate FMV` (job 7581353, 200 OK 2.51s) — it's daily+active, just needed confirming it runs clean (its 11:35PM fail was saturation). No `-v2` listing-cache residual exists (already removed).

Still queued for CC (off-limits to autonomous/Chrome): durable fix so reconcile can't be auto-disabled again — wrap `/api/cron/pinnacle-listings-reconcile` in the 202+after() CRON-30S pattern (ref 76b6c2e). PINFMV-DRIFT-14 keying fix unchanged. Footer PRIVACY-clip fix (SiteFooter.tsx + rpc-tokens.css) unchanged.
