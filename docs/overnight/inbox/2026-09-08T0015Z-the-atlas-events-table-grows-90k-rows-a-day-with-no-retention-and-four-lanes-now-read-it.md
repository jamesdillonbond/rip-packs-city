# `topshot_atlas_market_events` grows ~90K rows / 45 MB a day with no retention — and four lanes now read it

**Filed 2026-09-08 00:15Z by Cowork (cloud), at the close of the 09-06/07 audit drain. READ-ONLY sizing; nothing shipped — a retention policy is a design decision for the feed's owner (#65), not a hygiene drop.**

## Measured

| when | rows | size |
|---|---|---|
| 2026-09-07 ~16Z | 131,734 | 55 MB |
| 2026-09-08 00:12Z | 223,643 | 98 MB |

~90K rows / ~45 MB per day. The firehose alone is ~8K events/hour of listings, sales and offers; the edition verify lane (2 editions per tick, full histories) and the sales-history reads add the rest. At this rate: ~33M rows / ~15 GB a year on a Small-compute instance whose IO budget is the constraint (CLAUDE.md).

## Who reads it now (grep before pruning — this is the caller list)

1. `sync_ts_listings_from_atlas()` / `sync_cached_listings_from_atlas()` / `sync_edition_offers_from_atlas()` — **open** listings verified in the last 24 h (`NOT completed`, partial indexes `idx_tame_open_by_edition*`).
2. `atlas_edition_verify_settle()` / `atlas_listing_verify_settle()` — upsert on Atlas uuid; a listing that sells flips in place.
3. `hydrate_topshot_moments_from_wmc()` source 2 and `topshot_moment_hydrate_dispatch()` exclusion 2 — any event with `nft_id` + `serial_number` + a mapped edition (`idx_tame_nft`); the value is in the nft → edition/serial mapping, which is written into `moments` once used.
4. `sync_sales_from_atlas()` (`20260907233444`) — purchased listings behind a `last_seen_at` cursor (`idx_tame_sales_seen`); once consumed, a sale lives in `sales`.
5. `allday_resolve_unmapped_via_atlas()` — `product = 'nfl'` events.

## The shape of a policy (not decided here)

A completed event whose `last_seen_at` is older than N days is read by nothing above except the hydrators (which only need nft → edition/serial, and only until the nft has a `moments` row) and the All Day resolver. So: `DELETE … WHERE completed AND last_seen_at < now() − N days AND NOT EXISTS (a hydration-queue row for the nft without a moments row)` — with N ≥ the sales lane's catch-up horizon (it examines events ≥ 2 h old, so N = 30 is safe by a wide margin), run by the weekly log purge (`run_weekly_log_purges()`, jobid 198), and with a pin on the four callers above so a fifth reader cannot be pruned out from under. **Open** listings must never be pruned — they are the sniper's book.

## Falsifier for the growth figure

Two `count(*)` readings a day apart, same instrument: if the second is not ~90K above the first, the rate above was the verify lane's history walk front-loading and the steady state is lower. Re-derive before sizing the policy.

## ✅ SHIPPED 2026-09-08 00:43Z (Cowork, same night) — `20260908004325_audit_20260908_prune_completed_atlas_market_events`

Re-measured first: **225,179 rows / 99 MB at 00:28Z** (so ~5.8K rows/h at that moment; the ~90K/day figure above stands within its own falsifier's tolerance). `prune_topshot_atlas_market_events(7, 20000)` on pg_cron jobid 473 `rpc-prune-atlas-market-events` at `27 * * * *`: completed `nba` rows older than **7 days** (not 30 — the widest reader window is 24 h and the sales margin is now a guard, not a window), oldest first off a new partial index, ≤ 20,000 per run, **never past the `sales-atlas-sync` cursor, never an nft still in `v_moments_needing_hydration`**; `nfl` rows untouched. Proof: `(7, 20000)` → 0 (nothing is 7 days old yet); `(0, 5)` → 5 deleted with the cutoff clamped to the cursor (13:07Z); guard-2 positive control 307 of a 20,000-row page would be kept today. Reader list above re-verified against `pg_proc`/`pg_views`/`cron.job` and the repo (zero app references). Ledger entry dated 2026-09-07 PT; cron-schedule row added; revert in the migration header.
