# NBA Top Shot — collection roadmap (refreshed 2026-10-17, PT)
> Dated snapshot; every number is a dated sample — re-derive before quoting. Canonical plan: [roadmap-2026-10-17.md](../roadmap-2026-10-17.md). Defects: [known-issues.md](../../reference/known-issues.md) (item text wins over this file).

## Where it stands

Top Shot is the one collection through its accuracy gate. It also has the deepest data on the platform: ownership, packs, offers and the sell-back history.

- **M1 (Top Shot HIGH/MED share ≥ 50 %): MET**, every leg since 09-21. Weekly means from `rpc_trust_health_history` (read live 2026-10-17 ~6:00 PM PT; all-rows denominator, decided 08-28): wk 09-14 50.7 (18/28 legs at the bar) · 09-21 **55.2** · 09-28 56.7 · 10-05 57.1 · 10-12 **55.8** (23/23 legs so far, min 55.2). Latest leg is 55.2 (12:48 PM PT), `fresh24h` 70.4 %, stale > 30 d 0.0 %. The week is drifting about 1 pt down from 10-05. That is still inside the band, but watch it.
- **Price vs realised sales (R125, closed 10-17):** FMV 1.8.0 (median of the last 7 typical sales, shipped 10-03) matches or beats a naive last-3 median on HIGH and MEDIUM when the two are compared on the same rows. Over 7 days published FMV has a 13.3–14.3 % median absolute error at ratio 1.000; HIGH has 9.5 % error with 84 % of sales within ±25 % (10-17 overnight and afternoon handoffs). Weak spots: LOW (23.7 vs 21.4 % paired) and ASK_ONLY (ratio 1.35, n 102).
- **Sweep:** `topshot_fmv_sweep_pct_24h` is 78.2 % (12:48 PM PT). It was depressed by the step-1b wedge from ~12:48 to ~5:35 PM PT. The fix (ledger 10-17) is live: the 5:35 PM run logged `cursor_held=false`, and every run since has advanced. fmv-recalc ran 152 of 152 ok in 24 h.
- **Ownership index** ([topshot-ownership-index.md](../../reference/topshot-ownership-index.md)): ~526 k rows (estimate, 6:00 PM PT), up from 281 k on 10-15. Squeeze-board concentration has 2,272 of 3,981 editions census-complete. 5,057 of the 7,455 `series8_era_backfill` wallets are still unwalked; the walk does ~800 per run, 9 of 9 ok in 24 h, so they should clear before tip-off.
- **Listing sources:** Atlas `ts-listings-atlas-sync` ran 288 of 288 ok in 24 h, and the 51 k `source='topshot'` asks come from Atlas. Flowty `topshot-listing-cache` is **still alive** (72 of 72 ok in 24 h, 6:00 PM PT). `topshot-pack-supply-atlas` failed 424 of 1,413 runs (30 %), its chronic Cloudflare-403 backoff.
- **Demand** (10-08..10-14 baseline): ~61 human browsers and 6 external signed-in users. Alerts are the feature people use. No paid tier until 100 WAU (CLAUDE.md, 09-25).

## Shipped recently (since mid-September)

- **Pricing:** FMV 1.7.0 → **1.8.0** (10-03), after the first out-of-sample backtest showed the old weighted average trailing a last-3 median. #140 (cold-population caps, 09-25), #169 (`sales_market` excludes Dapper buy-backs, 10-10), R126 (`updated_at` touch trigger for the haircut writers, 10-15). The thin-FMV and display-guard rebuilds now compute their rows before they TRUNCATE, which ends the 1:30 AM edition-page timeouts (ledger 10-17).
- **Data completeness:** sell-back walk recovered ~634 k 2025 sell-backs (#167). Parallel/subedition mis-keys fixed (#173, #175; D25 resolved 10-17 with 0 impossible serials). Offers capture: 17,257 accepted offers recovered, Atlas fallback added, 4.0 % of fills still have no offer row (#189). Rip-drop identity re-keyed estate-wide (ledger 10-11).
- **Ownership / squeeze:** `walk_missed_at` added (10-15), so boards count only walk-confirmed holdings. Squeeze "Top 5 hold" is measured against live supply (`refresh_topshot_edition_concentration_v2`). The walk now covers sets 219+ that Dune never indexed (10-16). Unplaced-id prediction and hydration run at 60 ids per run. Candidates are seeded hourly. 7,455 Series 8-era wallets were backfilled (10-17).
- **Series 2026-27 readiness (10-15 → 10-17):** `9: "Series 2026-27"` is in every series map, with a guard. `topshot-set-series-onchain` fails on an unknown series. The new-set frontier is probed every 10 min. Circulation is capped from Atlas (job 457).
- **Packs:** pack pages read live Atlas tier counts (10-14). They had been frozen since 08-28 under "live" copy. Pack Reality's fabricated "11 % delivered nothing" was removed (10-14). Containers and boxes are priced (#188). The issuer-held split reads `ok` (#185). The Pack Sniper shows real names for untitled packs (10-17).
- **Market and alerts:** filters cover the whole catalog, parallels carry badges, and team picks cover franchise renames (10-13/10-14). Deal alerts dedup on ask (verified 10-16). FMV alerts fire on transition (10-14). Flowty lanes fail on an empty book (`f0b7f7ba5`, 10-15).

## Open issues

- **#189 (partial):** 3,243 of 81,720 offer fills (4.0 %) have no offer row. They are pre-spork with no Atlas event, so this is probably the floor.
- **#181 (partial):** mainnet24 historical node now fails DNS; 410 probes sit at `floor`. Review is due **10-24**: retire pre-mainnet27 lookups if the node is still dark, and state it in the pack-history UI.
- **Series-label convention:** live `collection_series` 6/7/8 still read "Series 5/6/7", re-read 10-17. Series 9 will read "Series 2026-27". `series-param.ts` resolves both, but there are two conventions side by side (inbox 2026-08-18).
- **`never_queued` parallel-seed watch** ([focus.md](../../overnight/focus.md), 10-17): 66,001 at the fix. It should fall each ~20 h cycle; file it if it does not fall across two cycles. Not re-read here (the query is heavy).
- **Pack EV writer drift:** the `compute-topshot-pack-ev` edge function has no caller. The live EV writers are `refresh_atlas_pack_ev`, `refresh_container_pack_ev` and the historical backfill ([packs.md](../../reference/packs.md)). Retire the function together with its `topshot_pack_ev_targets` view, or revive both. #174 (fmv-backfill still stamps 1.5.0) was decided as no change.
- **Not tracked:** autograph/partner status (no DB field). Older-season Rares burned by Constellations sit in Dune-era sets the walk does not cover, so those holder counts lag.
- **Parked SQL:** none left — the `idx_tame_open_listing_by_seen` drop is ✅ dropped 10-17 evening (`20261018005800`, verified in prod; ledger).

## Next — prioritized

### Now (through 2026-10-24)
1. 🛠 **PRE-LAUNCH CHECK 2026-10-18 ~9:45 AM PT (Claude Code cloud, read-only sweep + fixes):** `sets` holds series 0, 2–8, nothing at 9; `registerNewSeries` (`topshot-set-series-onchain`, hourly :35, 24/24 ok) inserts the `collection_series` row on its own, and every canonical TS map already had 9 → "Series 2026-27". **Fixed the same morning** (`20261018162955` + code): `get_team_checklist`/`_progress` `series_season` stopped at 8 (every Series 9 edition would have dropped out of the Contemporary checklist); `analytics_sets_series_overview` would have labelled it "Series 9"; the sniper feed (blank label), concierge deal search ("S9") and `/api/fmv` short maps lacked 9. Guard: `__tests__/series-2026-27-in-every-series-map.test.ts`. **Watch on 10-20, not defects:** new sets read "No series" for up to ~70 min until the next :35 run; on-chain circulation (9:05 PM PT) and pack-dist names (9:25 PM PT) land AFTER the 7 PM verification, so re-check after 9:30 PM; `lib/packs/live-pack-listings.ts` labels by date with a 10-19 5 PM PT cutoff, so a late Series 8 pack dropped that evening would read 2026-27; `topshot-pack-supply-atlas` fails ~21 % of runs (not series-specific); the new series page URL is `/series/series-2026-27` while 2025-26 stays `series-7` (inconsistent, nothing breaks). Confirm `TopShot.currentSeries = 9` on chain before trusting a label (Flow REST was unreachable from the sandbox). (The 9 `sets` rows with truncated names and NULL series — "Archive Set 2014-", "WNBA " — were all created in ONE batch 2026-04-16 9:08 PM PT with 0 editions: a one-off backfill, not a live writer, so no launch risk.)
   - (original item) **Verify Series 2026-27 ingest end to end on tip-off.** What: sets, `collection_series` 9, circulation vs Atlas, index rows and pack labels. Why: a new series is where label, circulation and ownership defects appear first. Gate: scheduled task `trig_01WkbSku…` fires **10-20 7:00 PM PT** (confirmed armed 10-17). Done when series-9 editions read at or below Atlas circulation and carry index rows. Falsifier: `topshot-set-series-onchain` logs an unlabelled-series failure. **Ready-to-run queries (Q1–Q6, each with a series-8 control row measured 10-18): [series-2026-27-launch-checks.sql](../../operations/series-2026-27-launch-checks.sql).**
2. **Hold M1 through launch volume.** What: read the weekly mean. Why: new editions arrive thin and LOW/ASK_ONLY, so the share can dip by mix alone (the Panini 09-20 trap). Gate: before calling any drop a regression, split repeat vs newly-reached editions. Stop if the repeat cohort holds.
3. ✅ ~~**Watch the sweep after the wedge fix.**~~ **CLOSED 2026-10-18 ~8:00 AM PT (Claude Code cloud) — the fix holds, and the gate's "~90 %" was a wrong premise.** `v_fmv_sweep_wedge`: 0.08 h since the last cursor advance, 121 advances in 24 h. 91 of 91 `fmv-recalc` runs since 10-17 5:35 PM PT were ok, and none logged `cursor_held: true` (⚠ the key appears on only 2 of 377 runs in 60 h, so it is a weak falsifier; the wedge arm is the instrument). Every one of the 14,528 latest Top Shot snapshots is < 7 days old (0 older). **`topshot_fmv_sweep_pct_24h` is a structural ~75–80 %, not a depressed reading:** its daily mean sat at 75.0–80.3 % on every PT day 09-27 → 10-18, wedge or no wedge. Do not gate on "> 90 %". The breach is a fall below ~74 % on two consecutive days, or any edition > 7 days old. (Original gate: `fmv_sweep_wedge_hours` < 3 and `topshot_fmv_sweep_pct_24h` back above ~90 % within a cycle. Falsifier: another step-1b run with `cursor_held=true` and 0 fetch errors.)
4. 📏 **Read 2026-10-18 ~9:40 AM PT (Claude Code cloud):** `series8_era_backfill` unwalked **5,057 → 1,063** (of 7,455; `pack_opener` 0 and `marketplace_buyer` 3 unwalked), so it clears before tip-off at ~800/run. **Census-complete is FLAT at 2,272 of 3,982**, and that is a real plateau, not a stale instrument: the stored census tracks live ownership (513,076 stored vs 513,786 walk-confirmed rows now; job 682 succeeded every 6 h, 2.4 s). Of the incomplete editions, 803 sit at 90–100 % of mint (670 already complete against LIVE supply) and ~1,000 below 60 %, so the remaining supply is held by wallets the walk has not found, not by a lagging refresh. Lifting it needs a new WALLET source, not more walks of the same candidates.
   - (original item) **Finish the Series 8-era walk backlog and lift census coverage.** Gate: `series8_era_backfill` unwalked → 0 and census-complete rising from 2,272. Revisit the hydration rate only if the unmapped actionable backlog stops falling between walks; read pgss blocks per call first (the 10-17 revert).
5. **#181 review 10-24.** Retire or keep the pre-mainnet27 lookups, per the item text.

### Next (to ~2026-11-15)
1. **2026 rookie class from Series 9 sets, on/after 11-11.** What: build the class and point the rookie boards and collector leaderboard at it. Why: the 2025 list is a VIEW over Series 8 set names. Gate: build only from minted Rookie Debut sets. Never seed from the draft or the four partners, which would silently drop ~56 of ~60.
2. **Close the LOW-tier price gap.** What: re-read R125 paired; LOW is 23.7 vs 21.4 %. Falsifier (R125 reopen rule): a paired within-25 share more than 3 pts below last-3 for two weeks running. Labels stay as they are (the M2 decision logic applies).
3. **Decide the Flowty teardown in advance.** When Flowty goes dark: confirm by the lanes' own `pageErrors`, retire the three listing-cache sweeps and `flowty-proxy`, and drop the `flowty` rows deliberately instead of waiting out the 48 h purge. Top Shot's asks are Atlas-fed and unaffected (roadmap-status #1).
4. **Re-read demand 10-15..10-21 on/after 10-22**, against the baseline (Google one-page 19/26; paste → sign-in 10 → 0). Measurement only, no outreach.

### Later (gated)
- **"Cost to climb into the top N" board** for Yearbook / Blue Chip / Squad Goals. Gate: Top Shot's official 2026-27 scoring (needs Trevor). Never publish an RPC rank as Top Shot's.
- **Dual-scale valuation / six-section parity** ([roadmap-2026-08-03 §6](../roadmap-2026-08-03.md)): sequenced behind the gate for all collections, not just Top Shot.
- **Retire pre-2023 history gaps** only with revenue (#190 declined).

## Decisions on record (do not re-litigate)

- Read-only product: no cart, trade or gifting (#1, #3, #3b). Trading is a Trevor-only call ([trading-revisit-2026-10-03.md](../trading-revisit-2026-10-03.md)). Admin-signed giveaways are the only exception.
- The M1 denominator is ALL ROWS, not canonical-only (08-28). Read it from the precompute or history, never from `rpc_fmv_confidence_share()`. 999 is the failure sentinel.
- FMV 1.8.0 = median of the 7 most recent typical sales (10-03). Public per-edition confidence chips stay banned (09-25).
- Do NOT extend `topshot_normalize_circulation` to series 9 (/500 Rookie Debut vs its 1,000 floor).
- Set 218 (Series 8 Base, ~1.54 M) stays out of the ownership index on purpose. Dune rows are kept, because they size paid walks.
- Series 0↔1 is Top Shot-specific (#168). Never blanket-remap it across collections.
- #190 pre-2023 pack-open history declined (infra spend). #138 no mega-wallet id source. #172 phone is the giveaway path. Achievements not widened (10-17).
- No paid tier until 100 WAU. No infra spend pre-revenue. No growth tactics or outreach until the gate passes.

## Needs Trevor

- ✅ **2026-27 leaderboard boards: DECIDED 10-17 (delegated) — not built until Top Shot publishes the official scoring** ([roadmap-status.md](../../reference/roadmap-status.md), "Decisions taken — the docs-refresh open list").
- **Flowty shutdown date**, if he hears it, so the teardown happens on the day.
- Standing, estate-wide: the credential-purge residue (#22).

## Where the detail lives

- Live numbers and launch-readiness block: [roadmap-status.md](../../reference/roadmap-status.md) (first `⭐ NEW` / `⭐ HEADLINE METRIC` blocks)
- Ownership index mechanics and cost model: [topshot-ownership-index.md](../../reference/topshot-ownership-index.md)
- Packs, EV writers, spork nodes: [packs.md](../../reference/packs.md)
- Register: [known-issues.md](../../reference/known-issues.md) · [deep-audit-register.md](../../audits/deep-audit-register.md)
- Steers and watches: [focus.md](../../overnight/focus.md) · Change log: [ledger.md](../../overnight/ledger.md)
- Latest handoffs: [10-17 afternoon](../../handoff-2026-10-17-cowork-afternoon-pass.md) · [10-17 overnight](../../handoff-2026-10-17-overnight-pass.md)
- Prior plan: [roadmap-2026-08-03.md](../roadmap-2026-08-03.md)
