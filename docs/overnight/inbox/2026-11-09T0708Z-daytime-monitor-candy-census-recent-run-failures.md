# Daytime monitor — 2026-11-09T07:08Z (≈11:08 PM PT 11-08): candy-collections-census failed its last 4 runs

Read-only daytime sweep. Otherwise GREEN (one-liner at the bottom). **NOT in a saturation spell now** — `pg_stat_activity` positive control at 07:08Z read io_wait=3 / active=5 (39 total) and `rpc_ops_snapshot()` returned fast; the 04:12Z tick's spell has cleared.

All 5 trust-health breaches are already filed and unchanged in kind — not re-raised here:
- `edition_integrity_flags` now **20627** (was 10392 at 01:05Z) as the Candy census keeps inserting tier/circulation/thumbnail-null editions (`candy_mlb` editions 12,259 → 22,127 over the same span). Decision path already in `2026-11-09T0105Z-daytime-monitor-candy-census-edition-integrity-breach.md`.
- The four Candy-closure breaches (`candy_sales_stale_hours` 664h, `candy_ask_book_drop_pct` 86.2%, `public_board_empty_count` = `candy_offer_spread_board`, `public_board_slow_count`) filed 22:05Z / anticipated 01:05Z. `public_board_slow_count` crossing the precompute threshold is exactly what the 01:05Z "watch only" note predicted; the live slow probe at 07:08 is `v_topshot_parallel_premiums` (8.36 s / 4,946 rows, one reading, healthy) plus the Candy scarcity-board class. `topshot_pack_reality_top_ev` row_count 0 is the known frozen 08-30 state row, not a live empty.

This file adds ONE new signal.

---

## 1. [MED · pipeline · quiet-window CONFIRM] `candy-collections-census` failed its last 4 runs (03:57–06:57Z) after 3 clean runs

- **Source:** `rpc_ops_snapshot()` `pipeline_alerts` HIGH (`failure_rate` 5/8 over 3 calendar days); `pipeline_runs WHERE pipeline='candy-collections-census'` (read 07:00Z).
- **Sequence:** 00:43 / 01:43 / 02:43Z `ok=true` → 03:57Z & 04:57Z `ok=false` *"ghost purge: canceling statement due to statement timeout"* → 05:57Z `ok=false` *"2022 Leadoff ICONs: page 66: wallet_moments_cache: canceling statement due to lo[ck/timeout]"* → 06:57Z `ok=false` *"2022 Leadoff ICONs: page 66: DAS getAssetsByGroup error: Database Error: Query E[rror]"* (upstream Solana DAS). (The slot moved :43 → :57 per the 11-08 census-timing fix.)
- **Two layers, split deliberately:** the **ghost-purge** timeout (03:57 / 04:57) was the step fixed overnight by `audit_20261108_candy_wmc_ghost_purge_scoped` (`20261109044509`, ~04:45Z) — those two fails predate/coincide with the fix and should clear on the next ticks. The **05:57 / 06:57** fails are a DIFFERENT step (per-set hydrate of "2022 Leadoff ICONs" at page 66) and land AFTER the saturation spell cleared, so they are **not pure spell collateral**: one is a local `wallet_moments_cache` statement-timeout, one is an upstream DAS "Database Error".
- **Why it matters:** this is the pipeline landing the Candy census editions that drive the open `edition_integrity_flags` breach (01:05Z item). If the census wedges on one set's page it stalls that drain. It is **NOT** a wipe/outage — 3 of the last ~9 runs succeeded and `candy_mlb` editions grew ~10k in the window, so the census is progressing; it is being actively tuned by the night pass (11-08 shipped the :43→:57 slot move, the per-page denorm fix, and edition-key hashing).
- **Risk:** low blast radius; read-only observation, no action taken.
- **Suggested action (night pass — quiet-window CONFIRM, not a causal verdict):** after the ghost-purge fix has had a few ticks, read the last ~6 `candy-collections-census` runs. If the 05:57/06:57-class *"2022 Leadoff ICONs page 66"* fails keep recurring across quiet windows, the census is wedged on that one set — re-measure the per-call cost of its hydrate/`wallet_moments_cache` step (and whether that set's DAS group is erroring upstream) and consider a smaller page/row budget for it, the same shape as the 11-08 label-fill step-size cut. If the fails were only the spell plus the now-fixed ghost-purge step, they clear on their own and this closes with no change.

---

**Healthy baseline (07:08Z):** security invariants/anon-write/RLS/secdef all `[]`; `detect_stalled_pipelines()` `[]`; `check_pgcron_recent_failures()` `[]` (rpc-candy-wmc-label-fill fixed overnight); sentinel TS-UUID-editions-48h = 0; 17 migrations since 01:00Z all additive (`audit_` prefix, grep of bodies shows DROP/RENAME only inside rollback comments) → the 13/13 dashboard validation from 01:05Z still holds; last production deploy READY (`7f02c1e`, "job 848 first run verified"; the newer production builds are CANCELED supersede-noise from heavy doc/ledger pushing, no ERROR); client_error beacon 0 in 12h (no spike). FMV HIGH+MED by snapshot: nba 6271, panini 18466, nfl 1598, pinnacle 982, candy 2, golazos 1, ufc 0. DB 49,266 MB.
