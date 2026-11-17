# Handoff — `saved_wallets` cached counts are stale platform-wide (dashboards understate every user)

**Date:** 2026-08-08 (PT)
**Author:** Cowork session (Trevor-directed)
**Type:** Data-freshness bug + fix. DB reconcile (immediate) + route/cron wiring (durable) — for Claude Code.
**Risk:** Low. `cached_*` are display columns only; no auth/ownership/lockdown impact.

## Symptom

The profile/dashboard/`/share`/OG cards render `saved_wallets.cached_moment_count` + `cached_fmv_usd`, and these are broadly **stale or NULL** — understating collections by hundreds to thousands. Measured live 2026-08-08:

- **All 21 logged-in users affected** (21 of 21).
- 99 `saved_wallets` rows total: **24 are `cached_moment_count IS NULL` while the wallet holds moments** (card shows 0/blank), **41 rows drift >5** from actual wmc.
- Examples: `Edogg1976` Top Shot cached=NULL vs actual 12,552; `brianw4` NULL vs 10,552 (+ All Day NULL vs 4,045); `Rigged` 33,374 vs 38,097; `AbsolutSiikness` 6,842 vs 11,406; `ThunderHour`/visiondist Top Shot cached=**50** vs actual **1,474** (the stale shallow-warm value, even after his deep backfill).
- `cache_updated_at` is frozen at 2026-05-11 / 06-10 / 06-15 for most rows — i.e. written once at signup and never refreshed.

## Root cause

`cached_moment_count` / `cached_fmv_usd` are only written by the per-wallet RPC `aggregate_saved_wallet_stats(p_user_id uuid, p_wallet_addr text)` (reads wmc as source of truth, updates all of that wallet's `saved_wallets` rows). It is called **only** from the signup/association path (`resolve-and-associate`) and the saved-wallets flow — **never on a schedule**, and **not after a deep backfill**. Meanwhile wmc keeps growing via scheduled scans, so the cards drift further out of date every day. There is **no bulk/periodic reconcile function** (confirmed: only the per-wallet RPC exists).

## Fix

### 1. Immediate reconcile of the current base (safe, idempotent)

Run once (Supabase SQL editor or Claude Code). Refreshes every card from wmc:

```sql
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT user_id, wallet_addr
           FROM saved_wallets WHERE wallet_addr IS NOT NULL LOOP
    PERFORM aggregate_saved_wallet_stats(r.user_id, r.wallet_addr);
  END LOOP;
END $$;
```

21 users × 1 wallet each = trivial. Verify after: the drift query (below) should return ~0 drifted rows.

### 2. Durable — refresh on deep backfill

Call `aggregate_saved_wallet_stats` at the **end of the multicollection backfill** so a deep walk immediately refreshes the cards. Cleanest spot: after the sync children settle in `app/api/wallet-backfill-multicollection/route.ts`'s `after()` block, look up the `(user_id, wallet_addr)` rows in `saved_wallets` for that `wallet` and `PERFORM` the RPC per user. (This also fixes the "warmed on sign-in but card still shows 50" gap for every future signup — it complements `c6b55735`.)

### 3. Durable — periodic reconcile cron

Add a low-frequency job (nightly is plenty) that runs the DO-block in #1 over all saved wallets, so cards never drift more than a day behind wmc. Either a pg_cron job calling a new `reconcile_all_saved_wallet_stats()` wrapper (SECDEF, service-role) or a Vercel cron hitting a small admin route. Keep it cheap — 99 rows today, and it scales with user count, not moment count.

## Verify query (drift monitor)

```sql
SELECT sw.username, col.slug, sw.cached_moment_count AS cached, cnt.actual,
       (cnt.actual - COALESCE(sw.cached_moment_count,0)) AS diff
FROM saved_wallets sw
JOIN collections col ON col.id = sw.collection_id
LEFT JOIN LATERAL (SELECT count(*) AS actual FROM wallet_moments_cache w
                   WHERE w.wallet_address = sw.wallet_addr
                     AND w.collection_id = sw.collection_id) cnt ON true
WHERE abs(COALESCE(sw.cached_moment_count,0) - cnt.actual) > 5
ORDER BY diff DESC;
```

Should return near-empty after #1 ships, and stay empty with #2 + #3.

## Note for the onboarding-funnel watch

Consider adding this drift check to `rpc-pending-signups-watch` (it already knows the wallets) so future staleness is caught automatically. Optional — #3 makes it moot if it lands.

## Revert

#1 is a data refresh (no revert needed — it only makes counts accurate). #2/#3 are code/cron: `git revert <sha>` + drop the cron job.
