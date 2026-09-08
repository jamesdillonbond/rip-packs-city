# Daytime monitor — 2026-09-08 ~14:10 PT (21:10Z)

Read-only ~3h health sweep. Estate is green except one early-warning arm. Not in a saturation spell (pg_stat_activity: 1 IO-wait / 0 active of 37 at sweep time), so durations below are interpretable — with the single-probe caveat noted.

## Candidate (LOW) — `pack_table_rows` warm probe crossed its slow-board cap after a week flat

- **Source:** `public_board_liveness_state` / `_history` for `view_name='pack_table_rows'`; trust arm `public_board_slow_count` = 1 (BREACH, breach_at 1). This is the one non-`ts_uuid_dupes` trust-health breach in `rpc_ops_snapshot()` this tick.
- **What:** the 20:28Z probe read **4903 ms** against this view's **3900 ms** cap; the 11:28Z probe was already elevated at **2128 ms**. Every prior probe back to 2026-09-05 sat **687–991 ms** (one-off 913/901). `row_count` is **5529 the entire history** (unchanged), `err` NULL — so this is latency drift, not data growth and not emptiness. Well under the ~30s read-path wall, so the page is not failing; the arm is doing its designed job of warning before a break.
- **Risk read:** LOW. Two consecutive rising 6-hourly probes is a weak trend, and each probe is a single point that can catch a brief contention spike (the arm fires on one warm sample). Stable row_count + unchanged query with a 6x latency jump points at stale stats / dead-tuple bloat / a cold visibility map on a backing table rather than a plan change from more data — but that's a hypothesis, not a measurement.
- **Suggested action (night pass):** re-probe `pack_table_rows` in a quiet window (confirm not a probe-time contention artifact); if the elevated warm time persists, `EXPLAIN (ANALYZE, BUFFERS)` it and check for stale stats / bloat on its backing relations (ANALYZE / the reindex targets) before touching the query. No code change indicated yet.

## Everything else — known / attributed, no new candidate
- `allday-lock-refresh` failure_rate alert (17/66, 25.8%, medium): upstream **Flow 400** ("Invalid Flow argument … Error Code 1052") on specific wallets — external, recurring, not our defect. Noted, not filed.
- Atlas 403 arms (`atlas-editions-upstream-403` 16.0%, `atlas-market-upstream-403` 23.2%): both **info**, request-id ATTRIBUTED (not the body-shape heuristic), Cloudflare challenge; last successful market drain 21:05Z / newest event 20:59Z, editions retry keeping up (0 of 266 sets stale >6h). No freshness loss — do not re-investigate (pg_net 403 is the attributed Atlas walk).
- `flow-rest-moment-moved-400` (18.9%, info): designed outcome — borrowMoment panic on sold/transferred moments, filed no_nft, re-asked after 30d.
- `unmapped-sales-nfl_all_day` (info): by-design frozen multi-NFT txs; ~27.3d to clear the actionable pile.
- `topshot-catalog-backfill` in `stalled_pipelines`: the seeded 2026-09-04 `no_marker` info item, not a new stall.
- pg_cron: `check_pgcron_recent_failures()` empty.

## Sweep results
- **Security:** invariants / anon_write_holes / rls_off_base_tables / secdef_anon_violations all `[]`.
- **Trust health:** 40/41 ok, 1 BREACH (`public_board_slow_count`, above). `ts_uuid_dupes_created_24h` 0, sentinel TS uuid editions 48h 0.
- **Artifacts:** 11 in manifest; every backing view/relation across the consolidated payload resolves (squeeze 501, set_squeeze 261, rookies 61, market 501, first_mint 501, pinnacle_scarcity 501, offer_spread 501, deals 29, trophies 501, new_collectors 64, cross_collection 1; pack_ev_latest / edition_offers / cached_listings_v2 / unmapped_sales / pack_table_rows all present). `topshot_pack_reality_top_ev` = 0 rows but is watchlisted `is_active=false` (empty-by-design) — not a break. No dropped/renamed object from today's ships broke a dashboard.
- **Vercel:** last 20 deploys are superseded CANCELED + READY, **zero ERROR**; latest production deploy READY.
- **Headline:** FMV HIGH+MED — TS 7259, AllDay 1350, Golazos 1, Panini(pinnacle) via history. Editions: TS 14015 · AllDay 6190 · Golazos 575 · UFC 518 · Candy MLB 125. DB 21,560 MB.
