# Handoff — P3 follow-ups (onboarding-conversion thread), 2026-07-21

> **STATUS (2026-07-24): COMPLETE.** Item 1 weekly-digest route shipped (disabled by default, `WEEKLY_DIGEST_ENABLED` gate) + its data-layer migrations committed; Item 2 pack-page Suspense refactor assessed already-done; Item 3 collapsed the 2 dead onboarding flags (kept `rpc:first-run-completed` — `FirstRunTourMount` is still mounted at `dashboard/page.tsx:1157`); `get_team_detail__test` dropped. Retained as historical record; no pending work.

## Context

Onboarding-conversion P0–P2 shipped + verified live (see `handoff-2026-07-20-onboarding-conversion.md` and the ledger entries). This covers the three P3 follow-ups. **Cowork has already shipped the one safely-shippable piece** (the retention-email data layer, below); the rest is frontend/route work for Claude Code. Repo HEAD at writing: `ef9b6d6`.

> Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape. Every path below was grep-verified against a fresh clone of `main`.

---

## Item 1 — Weekly retention email  (data layer SHIPPED live; send-route + cron for CC)

**Already applied to prod via MCP (commit the migration file for parity):** `public.get_weekly_portfolio_movers(p_min_abs_pct numeric DEFAULT 0, p_days integer DEFAULT 7)` — migration `audit_20260721_get_weekly_portfolio_movers`. Read-only SECDEF, **service_role-only** (anon/authenticated REVOKED — it returns emails; verified `has_function_privilege('anon',…)=false`). Returns one row per authenticated owner with ≥`p_days` of history:

```
user_id uuid, email text, latest_date date, latest_fmv numeric, prior_date date,
prior_fmv numeric, delta_usd numeric, delta_pct numeric, moment_count integer
```

Verified today: 20 movers (owner_key in `portfolio_snapshots` = auth user id → joined to `auth.users.email`), 9 of them ≥5% week-over-week. `portfolio_snapshots` has 977 rows / 22 owners / 72 dates (Mar 28–Jul 20), snapshot cadence ~daily.

**Commit the migration file** `supabase/migrations/<ts>_audit_20260721_get_weekly_portfolio_movers.sql` (SQL is in the applied migration; it's `CREATE OR REPLACE` + the three `REVOKE`s + `GRANT … TO service_role`). It's already live — the file is for repo parity; re-applying is harmless.
**Revert:** `DROP FUNCTION public.get_weekly_portfolio_movers(numeric, integer);`

**CC builds — a weekly-digest send route** (e.g. `app/api/cron/weekly-digest/route.ts`, `export const dynamic="force-dynamic"`, Bearer `CRON_SECRET` gate like the other cron routes):
1. `supabaseAdmin.rpc("get_weekly_portfolio_movers", { p_min_abs_pct: 5, p_days: 7 })` (start at ≥5% so the email always has a real number; tune later).
2. For each row, send via the **existing Resend pattern** — copy `app/api/subscribe/route.ts` lines 54–72 verbatim (POST `https://api.resend.com/emails`, `Authorization: Bearer ${process.env.RESEND_API_KEY}`, `from: "rpc-alerts@rippackscity.com"`). Subject e.g. `Your Rip Packs City portfolio: {+/-}{delta_pct}% this week`; body: latest_fmv, delta_usd/delta_pct, moment_count, a link to `/dashboard`.
3. **Unsubscribe is mandatory.** `email_subscribers` already has `verification_token` + `/api/subscribe/unsubscribe?token=` — but these authed-user recipients won't have an `email_subscribers` row. Simplest: on first send, upsert an `email_subscribers` row per recipient (`email`, `digest_weekly:true`, a token) and include its unsubscribe link; skip anyone with `unsubscribed_at IS NOT NULL`. Log sends to `alert_deliveries` (`alert_kind='weekly_digest'`, `channel='email'`) for dedup/idempotency so a re-run doesn't double-send.

**⚠ Gate — do NOT enable this without Trevor's explicit go (memory `no-promo-until-launch-ready`).** These 22 are the dormant early cohort; a weekly portfolio email is re-engagement, but it's proactive outbound to people who didn't opt into a weekly email. Ship the route **behind a disabled cron / feature flag**. When Trevor says go, **Cowork will wire the cron-job.org weekly trigger** (per `rpc-cron-ops`) — CC doesn't need to touch scheduling. Alternative audience if Trevor prefers pure opt-in: restrict to `email_subscribers WHERE digest_weekly AND verified AND unsubscribed_at IS NULL` (currently 0, grows via the `/share` DealWatchCapture hook) joined to their wallet's movement.

---

## Item 2 — Activation-path timeouts  (do NOT apply the fmv_current remedy — verified)

The 3 Sentry issues (`GET /[collection]/team/[slug]`, `/player/[slug]`, `/pack/dist/[distId]`, 1 event each) are **connection-pool-saturation collateral, not per-RPC bugs** — verified today via `pg_stat_statements`: `get_team_detail` has a **313 ms floor** (the ~9 s "mean" is pool-wait). All three fail-fast at 8 s and degrade to an empty section; this is the intended post-07-14 "throw retryable, don't silently 404" shape.

**Do NOT "swap to an fmv_current join / LATERAL-rewrite" these** (the note carried in the P3 queue). Memory `rpc-team-page-perf-disposition` records that LATERAL-rewriting `get_team_activity` **regresses it to ~18 s** (plpgsql variable-array planner trap). The team/player RPCs are already fast.

**Real fix (frontend, matches the proven 2026-06-30 pattern in `rpc-entity-page-connection-pool-fanout`):** the pack page render-gates on **9 RPCs** (`get_pack_lifecycle_row`, `get_pack_realized_ev_row`, `get_pack_market_row`, `get_pack_ev_contributors`, `get_fmv_for_editions`, `query_sql`, `get_pack_contents`, `get_pack_sales_history`, `get_pack_detail_bundle` — `app/(collections)/[collection]/pack/dist/[distId]/page.tsx`). Move the non-critical sections OUT of the render-gating `Promise.all` into `<Suspense>` async subcomponents (as was done for player Top Sales), and audit those 9 for any dead/no-op call to drop (e.g. the `special_serial_holders`-style empty round-trip that was removed from the edition page). Do **not** raise `statement_timeout`. Low urgency — 1 event each, self-degrading.

**Cleanup:** CC left a `get_team_detail__test` probe function in the DB during this investigation — `DROP FUNCTION public.get_team_detail__test(uuid, text);` when done.

---

## Item 3 — Identity-flag collapse  (frontend cleanup)

With the `OnboardingModal` mount removed, **three localStorage first-run flags are now dead**: `rpc_onboarding_complete` (was OnboardingModal, unmounted), `rpc_welcome_dismissed_v1` (WelcomeModal, unmounted 2026-07-06), `rpc:first-run-completed` (FirstRunTour). Remove their reads/writes; keep `rpc_owner_key` (the live localStorage identity, still used). Also fold the FCL Flow-wallet `CURRENT_USER` concept behind "connect wallet" only where it's actually needed, so a new user isn't juggling three identities. Low-risk; grep the four keys before deleting. See memory `collection-page-and-onboarding-modal-state` (don't re-mount WelcomeModal).

---

## Guardrails (standard)

- Direct to `main`, no branches/PRs. Commit ledger BEFORE code (docs-only tip suppresses the deploy). Verify push: `git rev-list --count origin/main..HEAD` → 0.
- Commit via PowerShell `git` on Windows; `curl` fails silently in Git Bash for Vercel REST (use `Invoke-WebRequest`). Vercel Pro `maxDuration` cap 800 s.
- `npx tsc --noEmit` + the vitest ratchet clean before push. Verify pages by rendered DOM, not HTTP 200.

## Expected end state

`get_weekly_portfolio_movers` migration + ledger committed; a disabled/flagged weekly-digest route wired to it (Cowork adds the cron on Trevor's go); the pack page's heavy sections Suspense-streamed (timeouts stop reaching users); 3 dead onboarding flags removed; `get_team_detail__test` dropped.
