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
