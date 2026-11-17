# Measurements owed — the 11-03 evening Claude Code session lost SQL access mid-turn (index-drop prompt unanswered)

**Filed:** Claude Code cloud, 2026-11-03 ~10:10 PM PT. Everything below SHIPPED in code (tests + planted defects red, preflight + CI green); what is owed is the production **incidence** read, which needs `execute_sql` — blocked after `DROP INDEX CONCURRENTLY` raised the Supabase MCP approval prompt a second time (9:10 PM PT) and went unanswered.

## 1. Top Shot Sniper — how many `ts_listings` rows have a NULL `series_number`? (fixes `9a393a9`, `ce07106`)
- `9a393a9`: an unknown series was labelled "Series 1" (`series_number ?? 0` defeated `seriesName`'s null guard).
- `ce07106`: the NAME fallback (`resolveEditionKeys`, rows with no `set_id`/`play_id`) keyed a NULL series as 0 and could price a keyless listing against Series 1's same-named edition.
- **Read:** `select count(*) filter (where series_number is null), count(*) filter (where series_number is null and (set_id is null or play_id is null)), count(*) from ts_listings;` — the second number is the misattribution-exposed population; if it is 0, record "fix was preventive"; if not, check whether any of those flow_ids appeared priced in the last sniper snapshot.

## 2. The staged index swap (needs Trevor's approval of a destructive statement)
- `docs/proposals/wmc-snapshot-cover-index-swap-STAGED.sql` — drop the 340 MB subset `idx_wmc_wallet_coll_ek_fmv_tier`, rename `idx_wmc_wallet_coll_ek_snap_cover` (246 MB, valid) onto its name. Read 11-03 9:10 PM PT: the planner splits reads between them (old +20k scans since 6 PM, new 173k) and every write maintains both. Run each statement ALONE (dashboard SQL editor or `execute_sql`, one call each).

## 3. #228 watch (restarted)
- Falsifier: a `RPC_READ_TIMEOUT` on `/api/collection-snapshot` from a NON-session caller after 8:30 PM PT 11-03 (`20261104042335` applied 8:23 PM PT). If it trips: the next lever is a CDN warm of the top wallets, not more SQL (the warm path is 428 ms / 54k buffers on a 63k-moment wallet).

## 4. Writer-side `?? 0` in the sales indexers — a FINDING, deliberately not changed
- ~12 writers persist `serial_number: x ?? 0` and `price_usd: parseFloat(...) || 0` (`sales-indexer`, `golazos-sales-indexer`, the `*-sales-history-backfill` crons, `ingest`, `lib/studio-sales-history.ts`, `pinnacle-sales-indexer`).
- DB readers widely filter `serial_number > 0` (promote / verification / serial-FMV functions), so 0 behaves as an "unknown serial" sentinel today. A price of 0 is the riskier half: any reader that does not filter `price_usd > 0` would average it in.
- **Read before changing anything:** `serial_number` nullability + unique/dedup keys on `sales` / `pinnacle_sales`; `count(*) where serial_number = 0` and `where price_usd = 0` per collection over 90 d; then grep readers of `price_usd` that lack a `> 0` filter. Only then decide NULL-vs-sentinel (a NULL could break a dedup key).

## Not owed (closed tonight, for the record)
- Pinnacle `set_name='Unknown'`: 111 of 148 recovered (`20261104043706`); 37 have no source.
- "Unknown (error loading)" player retired (`20261104045324`) and the minter refuses placeholders (`20261104050155`).
- Site search / Sets tab / analytics panels / giveaway / Buyback / Fast Break never print "Unknown" as a subject (ratchet widened).

## ✅ Reads taken 2026-11-03 ~10:55 PM PT (Cowork cloud, Supabase MCP `execute_sql` reads + Vercel runtime errors)

1. **Sniper NULL series — the fix was PREVENTIVE.** `ts_listings`: 41,109 rows, `series_number IS NULL` **0**, NULL series with no `set_id`/`play_id` **0**. No live listing was mislabelled "Series 1" or exposed to the name-fallback misattribution today.
2. **Index swap — NOT run** (destructive; it raised the MCP approval prompt for the Claude Code session, and Trevor's Chrome was unresponsive tonight, so it stays his click). Fresh read strengthens the case: both valid; old `idx_wmc_wallet_coll_ek_fmv_tier` **342 MB**, `idx_scan` 105.8M lifetime; superset `idx_wmc_wallet_coll_ek_snap_cover` **259 MB**, `idx_scan` 249k. The superset is smaller than the old index (bloat), so the swap frees ~342 MB and one index maintenance per wmc write.
3. **#228 watch — not tripped.** Vercel runtime errors (12 h): `/api/collection-snapshot` `RPC_READ_TIMEOUT` last seen **5:53 PM PT 11-03**, before `20261104042335` (8:23 PM PT). Nothing since.
4. **Writer-side `?? 0` — no measured incidence.** `sales` has `trg_sales_coerce_zero_serial_to_null`, so a written serial 0 lands as NULL: 90 d serial = 0 → **0** in every collection (NULL: TS 174, AD 1, GZ 6). `price_usd = 0`: **0** in 90 d, **3** all-time in `sales`; `pinnacle_sales.sale_price_usd = 0`: **0** all-time (column NOT NULL; `serial_number` nullable, 20,899 of 24,272 NULL in 90 d). So 0 is already not persisted as a serial, and a 0 price has not been written in 90 days. Changing the writers is hygiene, not a live defect; leave them unless a reader that lacks `> 0` is found averaging the 3 historical rows.

- **11-04 ~8:00 AM PT (Cowork) — index swap DONE.** Pre-check both valid; `DROP INDEX CONCURRENTLY` via the dashboard SQL editor (the MCP auto-cancels it); `ALTER INDEX … RENAME` via `execute_sql`; post-check `pg_get_indexdef` = INCLUDE (fmv_usd, tier, series_number, mint_count), 286 MB, old cover name gone. Record-only migration `20261104161510_audit_20261104_wmc_snapshot_cover_takes_the_tier_index_name` (file carries the runbook + revert); staged file deleted.


## ✅ RESOLVED — recorded 2026-11-04 ~8:00 PM PT (Cowork cloud)

All four reads were taken 11-03 ~10:55 PM PT (section above); the index swap it carried ran 11-04 ~8:00 AM PT (`20261104161510`). Nothing owed.
