# Handoff — new-signup capped card: close the card-refresh race (2026-11-08)

> ✅ **CLOSED 2026-11-08 ~8:10 AM PT (Claude Code, re-derived):** both items were already live when this was found uncommitted on the laptop. **Item 1** shipped 11-07 ~11 PM PT as `lib/wallet/saved-card-refresh.ts`, called from `app/api/wallet-backfill/route.ts` and `lib/chains/flow/wallet-backfill-helpers.ts` (ledger 11-07 "A new collector's saved cards now follow the walk that fills their cache"). **Item 2** is pg_cron job 833 `rpc-reconcile-fresh-signup-cards` (Cowork, 11-08 ~7:46 AM PT). Capped-card detector at ~8:08 AM PT: **0**. Kept for the record; nothing left to do here.

## Context
Cowork shipped nothing live for this item (the fast-lane cron in Item 2 was blocked by the Cowork auto-mode classifier). This handoff covers the permanent code fix. origin/main HEAD at authoring: 1d0e2be0b. Everything user-facing is already resolved: josh.pean's capped card was fixed manually via a `skip_cached:false` multicollection backfill, and prod was verified clean (0 capped cards) at 2026-11-08 08:32 UTC. The daily onboarding watch now carries a Check 8 capped-card detector.

## Root cause (verified from code 2026-11-08)
`app/api/wallet-backfill-multicollection/route.ts` — the `after()` worker dispatches 3 fire-and-forget children (incl. `nba_top_shot` -> `app/api/wallet-backfill/route.ts`) via `fireOnce`, which only kicks off each child's own `after()` Cadence walk (NOT awaited); then polls the 2 sync children; then calls `refreshSavedWalletCards(wallet)` -> `aggregate_saved_wallet_stats(user_id, wallet)`. So the card is aggregated while the fire-and-forget NBA walk is still writing `wallet_moments_cache` -> it can be computed from a page-capped (50) partial cache. The function's own comment says it is best-effort and relies on the pg_cron reconcile for convergence. But `reconcile_all_saved_wallet_stats()` (job `rpc-reconcile-saved-wallet-stats`, hourly :44) gates its refresh queue on `p_min_age_minutes DEFAULT 360`, so a fresh wallet is not corrected for ~6h.

Evidence: josh.pean wallet 0x4ea719c9a4febb47 NBA card=50 vs wmc=880, uncorrected across two hourly reconcile ticks. ajdong (same flow, minutes later) wrote correctly (NBA 2,480) — confirms an intermittent race, not a deterministic bug.

## Item 1 (P1) — the cure: re-aggregate the card on fire-and-forget child completion
Files (all verified present 2026-11-08): `app/api/wallet-backfill/route.ts`, `app/api/wallet-backfill-allday/route.ts`, `app/api/wallet-backfill-pinnacle/route.ts`, `app/api/wallet-backfill-golazos/route.ts`, `app/api/wallet-backfill-ufc/route.ts`, plus `app/api/wallet-backfill-multicollection/route.ts` (source of the `refreshSavedWalletCards` helper to factor out).

Change: factor the existing `refreshSavedWalletCards` body (user-gated via `saved_wallets.user_id IS NOT NULL`, idempotent, best-effort try/catch, runs after the COMPLETE telemetry row) into a shared helper, and call it at the END of each per-collection child's own walk — after that child has committed its wmc rows. Then whenever the slowest child (NBA) finishes, the card recomputes from the now-complete cache, closing the race at the source.

Why: the parent cannot await the fire-and-forget children (separate lambdas), so the only place that knows a collection's walk is done is the child itself.

Keep: the user-gated lookup (bounds cost to the ~handful of real users during the hundreds-per-wave seed sweeps); the "after the COMPLETE telemetry row" ordering; the 800s Vercel maxDuration cap.

Verify: `npx tsc --noEmit` clean; Vercel deploy READY for the commit; ride a real new signup with a >50-moment NBA wallet and confirm the card never shows 50 past the backfill window; the capped-card query below stays empty.

Revert: `git revert` the commit.

## Item 2 — quick mitigation Trevor can run NOW (independent of Item 1): fast-lane pg_cron
Cowork automation is blocked from creating scheduled jobs (auto-mode classifier: "Account & Standing-Rule Changes"). Run as Trevor in the Supabase SQL editor; convergence drops 6h -> <=15min. Reuses the pinned `aggregate_saved_wallet_stats`; isolated from the reconcile proc; reversible.

```sql
SELECT cron.schedule('rpc-reconcile-fresh-signup-cards','3,18,33,48 * * * *',$job$
  SELECT public.aggregate_saved_wallet_stats(t.user_id, t.wallet_addr)
  FROM (SELECT DISTINCT sw.user_id, sw.wallet_addr FROM public.saved_wallets sw
        JOIN auth.users u ON u.id = sw.user_id
        WHERE u.created_at > now() - interval '48 hours'
          AND sw.wallet_addr IS NOT NULL AND sw.user_id IS NOT NULL) t
$job$);
```

Slot 3,18,33,48 is clear of the stagger ban (0,1,20,21,40,41) and the heavy reconcile at :44 (verified vs cron.job 2026-11-08). Revert: `SELECT cron.unschedule('rpc-reconcile-fresh-signup-cards');`. Record it in `docs/operations/cron-schedule.md` after running. Once Item 1 is live this job is redundant — keep as a cheap safety net or unschedule.

## Do NOT edit reconcile_all_saved_wallet_stats directly
It is drift-pinned (three-file change: `supabase/tests/reconcile_all_saved_wallet_stats.sql` + migration + `__tests__/db-invariants-drift-guard.test.ts`) and has platform-wide blast radius (a bad body stalls ALL card refresh). Item 2 reaches the same convergence with none of that risk.

## Verification query (capped-card detector; now the daily watch Check 8)

```sql
SELECT u.email, sw.wallet_addr, c.slug, sw.cached_moment_count AS card, cnt.actual AS cache_actual
FROM saved_wallets sw JOIN auth.users u ON u.id=sw.user_id JOIN collections c ON c.id=sw.collection_id
LEFT JOIN LATERAL (SELECT count(*) AS actual FROM wallet_moments_cache w
  WHERE w.wallet_address=sw.wallet_addr AND w.collection_id=sw.collection_id) cnt ON true
WHERE u.created_at > now() - interval '3 days' AND sw.cached_moment_count > 0
  AND cnt.actual > sw.cached_moment_count;
```

## Guardrails
- Direct to `main`, no branches/PRs. If a `claude/*` branch is checked out, switch to `main` first.
- Commit via PowerShell `git` on Windows (Git Bash `git commit` can silently no-op); re-verify with `git rev-list --count origin/main..HEAD` == 0.
- Vercel REST: PowerShell `Invoke-WebRequest`, not Git Bash `curl`. Vercel Pro maxDuration hard cap 800s (higher sends the deploy to ERROR invisibly).
- No CRLF string-replace patching on Windows; use full-file writes.
- This push blocker is specific to the Cowork cloud/VM session (VM `/sessions` disk was 100% full; the cloud container has no attached repo). Trevor's machine + Claude Code push normally via Git Credential Manager / `gh auth setup-git`. The `remote.origin.pushurl` PAT route is DEAD (removed 2026-08-16).
- Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape.

## Expected end state
Item 1 committed on main, Vercel deploy READY, and a fresh signup's largest-collection card never shows a page-capped 50 past the backfill window (capped-card query empty). Optionally Item 2 running as the sub-15-min safety net.
