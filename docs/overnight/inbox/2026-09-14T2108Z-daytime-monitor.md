# Daytime monitor — 2026-09-14 21:08Z (14:08 PT)

**Environment:** sandbox bash/clone DOWN (the Sept-8 Windows-update mount failure, 6th day). Reads via file tools + Supabase MCP; **inbox written to mount, push unavailable** — night pass picks it up locally. Lock RELEASED (last run np-20260914-b1f7). NOT the first tick of day (2:08 PM PT) — 1a daily extras skipped.

**Spell positive control taken (per the 09-14 doctrine steer):** `pg_stat_activity` io_wait 0 / active 0 / 40 total at 21:06Z — **NOT in a saturation spell right now.** The timeout cluster below is therefore filed as observed collateral from an *earlier* window (~18:00–20:07Z), not a live spell, and no cause is asserted for it.

---

## NEW candidate (1)

### 1. `topshot_pack_reality_top_ev` renders 0 rows while its sources are fresh and populated — VERIFY genuine-empty vs filter regression
- **Source:** rpc-live-health payload `insights_counts.pack_reality_top_ev = 0` (validated this run). Cross-check: `mv_topshot_pack_rip_values` = **37,717 rows**; `pack_ev_latest` (TS) = **1,210 rows**, latest snapshot **20:25Z** (fresh); trust-health `public_board_empty_count = 0` (this board is either excluded from that monitored set or its emptiness is treated as expected).
- **Risk read:** LOW. Sources are present and fresh, so this is **not a failed read** — the derived view's own predicate is filtering everything out. Most likely genuine (no currently-purchasable Top Shot packs → "top EV" board legitimately empty), which is the honest-empty case the board-empty-copy framework is built for. But it is a public `/insights` surface reading zero and it is not in the ledger, so it deserves a look.
- **Suggested action (VERIFY, do not "fix" blindly):** (a) confirm whether `topshot_pack_reality_top_ev` is in the `public_board_empty_count` monitored set — if not, that's a monitoring gap (an empty public board that no honesty tripwire watches); (b) confirm the live `/insights` pack-reality page renders an honest empty state, not a broken/silent one; (c) establish whether the view predicate requires active/purchasable packs and whether that's currently true on-chain. If genuinely no-live-packs, add a one-line note so the next auditor doesn't re-chase it.

---

## KNOWN / NOT re-filed (context for the night pass, no action requested)

- **Saturation collateral cluster, ~18:00–20:07Z window (now subsided).** pg_cron: `rpc-refresh-market-index-daily`, `rpc-allday-listing-ask-fmv` (startup timeout), `rpc-allday-ev-corrected-refresh`, `rpc-refresh-topshot-pack-rip-values` (MV refresh), `rpc-thp-leg-impossible-parallel` — **all `statement timeout` / `job startup timeout`, zero logic errors.** Pipeline alerts of the same class: `snapshot-institutional-wallets` (62.5%, HIGH — chronic #42/#73/#84/M11, focus says do-not-re-file), `lock-check-batch` (27.7%), `price-snapshots` (38.9%), `run-insider-detectors` (25.8%). This is the documented instance-level saturation class, not N distinct bugs.
- **`trust_health` 1 breach: `public_board_slow_count = 10`** (breach_at 1). Slow, not empty (`public_board_empty_count = 0`). Same saturation collateral; boards serve. Not a new data-accuracy regression.
- **`topshot-active-listings-ingest` silent 1,194 min (~19.9h), last run 01:13 PT.** Known EXPECTED-to-fire arm (medium/visibility-only): the load-bearing feeder is a **residential Windows Task Scheduler task on Trevor's box**, and a >900min gap means the box has been dark — which given the Sept-8 update killing the sandbox VM may be the same root. TS FMV is unaffected (`topshot_fmv_stale_hours = 0.2`) because the Atlas firehose feeds the sniper. Surfaced already; noting the ~20h duration in case the box needs a nudge.
- **`pg_net_http_400` (HIGH, 1 call/2h):** body is a Flow execution-node `InvalidArgument` script error — the self-inflicted-probe / unknown-endpoint arm, not an outage. Single call.
- **`pack_distributions` data_stale 11d**, `unmapped-sales-nfl_all_day` info, Atlas 403 arms (6.0% editions / 1.3% market, both `info`, freshness intact) — all known.

## Health summary
✓ security 4/4 clean · trust 1 breach (`public_board_slow_count`=10, saturation collateral) · Vercel prod READY (newest CANCELED = docs-only ledger tip, expected) · rpc-live-health payload validated OK · FMV HIGH/MED TS 6,835 / AD 1,778 · DB 30.8 GB · not in a spell (io_wait 0) · 1 new candidate logged.
