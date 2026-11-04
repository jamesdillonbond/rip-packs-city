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

## Not owed (closed tonight, for the record)
- Pinnacle `set_name='Unknown'`: 111 of 148 recovered (`20261104043706`); 37 have no source.
- "Unknown (error loading)" player retired (`20261104045324`) and the minter refuses placeholders (`20261104050155`).
- Site search / Sets tab / analytics panels / giveaway / Buyback / Fast Break never print "Unknown" as a subject (ratchet widened).
