# Evening autonomous pass — 2026-11-21 ~7:10 → ~10:15 PM PT (Claude Code cloud)

**Brief:** Trevor, 7:10 PM PT: "work autonomously for the next 3 hours … fix anything you encounter."
**Start state:** trust board all ok, 0 stalled pipelines, no security invariants, 11 Vercel warning-or-worse lines in 24 h, 0 client errors since 11-15. Push to `main` worked (`git push --dry-run`).

## Shipped (all on `main`, all in the ledger)

1. **`topshot_pack_supply_tick` parks a delisted drop's 404** — migration `20261122031811`. Dist 8881 (disabled, endTime 2000, unlisted since 10-04) 404'd `not_found` 546 times and failed ~36 `topshot-pack-supply-atlas` runs a day. Now `extra.gone`, parked 30 days; a LISTED, enabled drop's 404 still fails. Verified live at 7:23 PM PT (`ok`, `gone 1`, `failed 0`). DB test + drift-guard pin updated.
2. **`topshot-onchain-art-backfill` rests its legacy leg** — code `7f4c6e064` (deployed READY). Zero fills every day since 10-19 while re-lapping ~1,070 editions `getCIDs` has no entry for (~2,200 Flow calls, ~9 min/day). A completed, error-free, zero-fill lap now sets `extra.legacy_rest_until` (+7 d). 8 new tests, two planted defects caught.
3. **`ts-listings-atlas-sync` counts rows it WROTE** — migration `20261122034049`. It logged the book size (~86.7k/run, 16.7M/day) as `rows_written`; now inserted+updated+deleted across `ts_listings` + `cached_listings` (533 on the first tick, exact), 0 on an errored tick.
4. **Six bloated indexes rebuilt CONCURRENTLY** (one-statement pg_cron recipe; jobs 902–905 removed; role timeout reset; 0 invalid indexes): `pack_ev_history` 543 → 171 MB (leaf density was ~30 %), `topshot_atlas_market_events` 752 → 158 MB (the open-listing cover was at 14 %). `analytics_packs_summary` cold read 20.8k pages / 23.2 s → 6.7k / 0.38 s.

5. **`fmv_recalc_historical_candidates` skips collections with no paid sale** — migration `20261122042722`. fmv-recalc's historical fallback timed out on 14 of 255 runs in 3 days; 9,320 of its 28,393 stale editions were Panini (0 rows in `sales`). Output hash identical on the production call and on an 8,851-row widened population; 1.18M → 698k buffers.

## Dated reads owed (also in `focus.md`, top steer)

- **`analytics_packs_summary` 500s** — 11 in the 24 h before the rebuild (last 03:06Z). Since 04:00Z: no calls yet at 8:20 PM PT, so no reading. Expect ~0: `select log_attributes['response.status_code'], count() from logs where source='edge_logs' and log_attributes['request.path']='/rest/v1/rpc/analytics_packs_summary'` (Supabase `query_logs`), and Vercel `[analytics/packs/summary] ok elapsed=` for Top Shot well under the old 13 s.
- **`ts-listings-atlas-sync` sync step** — median of `extra->'sync'->>'duration_ms'` since `2026-11-22 04:05Z` vs **4,595 ms** in the 48 h before. Three post-rebuild ticks read 2.2–4.3 s; not yet a claim.
- **`topshot-onchain-art-backfill`** — first run on the new code is 10:22 PM PT. Within ~12 h a run should read `terminated_reason = legacy_resting` with `legacy_rest_until` ~7 d out and `duration_ms` of a few seconds.
- **fmv-recalc historical fallback** — `extra.historical_fallback_error` count over 3 days vs 14 / 255 before `20261122042722`.
- **Re-bloat** — ~1 week: `pgstatindex('public.idx_tame_open_listing_seen_cover').avg_leaf_density` and `…('public.idx_pack_ev_history_listing_time')`. Under ~30 % → a scheduled weekly rebuild (each took < 40 s).
- **Candy funding gate (unchanged, from the earlier thread)** — 10:50 PM PT run. ✅ Pre-checked 7:30 PM PT via `pg_net`: Magic Eden returns `{"buyerEscrow": …, "balance": 0}` with `balance` a NUMBER, so `parseEscrowBalance` will parse it; the 4 `GFGmpV5z…` bids are active again until that run (the 4:50 PM run could not read the shape).

## Looked at and left (with the reason)

- **`wallet_held_pack_value`** (new today, sealed-pack total): 13 calls, mean 9.4 s, 3 PostgREST 500s (02–03Z). Single-wallet probes read 2.7–7.6 s (73k–181k buffers, mostly CPU), so the 500s look like the 12-wallet parallel fan-out contending, not one bad wallet. Failures are counted in `walletsFailed`, never $0. Not touched: its 56 KB inner function (`get_wallet_pack_history` v33) was shipped by another session hours earlier. **Candidate if it recurs:** cap the fan-out concurrency in `lib/packs/held-pack-total.ts` (e.g. 3 at a time) before touching SQL.
- **`analytics_packs_summary` skip-scan rewrite**: equivalent output, −27 % warm buffers — not shipped; the index was the lever (#121 rule).
- **`backfill-offer-fill-sales`** 734 duplicate-key errors/day in the Postgres log: by design (row-at-a-time insert, a 23505 is counted as `sales_duped`). Log noise only.
- **Anon `POST` 401s on `saved_wallets`/`profile_bio`/`trophy_moments`/`recent_searches`**: the smoke test's RLS probe (`checkRlsBlocked`), hourly.
- **Storefront reconcilers** rewrite every live listing's `verified_at` each pass — the confirmation stamp, deliberate. **`pack_nft_identity`** non-HOT upserts re-stamp `checked_at` — the ownership confirmation, deliberate.
- **8 Top Shot editions with no thumbnail** (7 WNBA Base Set 258 plays + `218:8066::16`): never sold, held or listed; the resolver has no entry; likely unreleased.
- **Security advisor**: 7 `function_search_path_mutable` (two are the COMMIT procedures that must not be pinned — database.md), the rest INVOKER; anon SECURITY DEFINER readers are the public profile/trophy reads.
- Open register items #234/#258/#66 are waiting on dated reads (11-23 accuracy week; watch query still 0); #249/#235/#229 are Trevor's or need a preview-verified design.

## Lessons promoted

- `database.md` (Index hygiene): index bloat on delete/key-churn tables is a cold-read cost every full scan pays — measure leaf density; screen query; the six rebuilds.
- `cron-and-schedulers.md` (end): the three lane defects and the query that finds each (a gone target re-asked forever; a count equal to what was READ; a walk whose remaining population cannot yield).
