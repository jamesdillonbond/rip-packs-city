# Disney Pinnacle — collection roadmap (refreshed 2026-10-17, PT)
> Dated snapshot; every number is a dated sample — re-derive before quoting. Canonical plan: [roadmap-2026-10-17.md](../roadmap-2026-10-17.md). Defects: [known-issues.md](../../reference/known-issues.md) (item text wins over this file).

## Where it stands

- **Grain.** A pin is a `pinnacle_catalog` row (`render_id`): **2,836 renders** (read 6:00 PM PT 10-17). `pinnacle_editions` is set-level and its `external_id` matches no held key. A character is the `characters` trait. `is_locked` is the contract's own maturity lock, so the data is kept and there is no lock UI. Pinnacle never reaches the shared analytics tables: FMV lives on the catalog, asks in `pinnacle_live_listings`, sales in `pinnacle_sales.render_id` ([schema-truth.md](../../reference/schema-truth.md), Pinnacle section at the end).
- **Accuracy share (its own leg, never averaged with the other collections).** `rpc_thp_leg_pinnacle_fmv_share` reads `pinnacle_fmv_history` by render_id. Weekly means: wk 09-28 **31.5** · 10-05 **31.5** · 10-12 **32.6** (23 legs). The latest leg reads **33.9** (2:55 PM PT 10-17), the highest since mid-September. Before that, the share slid **44.7 → 27.5** between 09-11 and 09-18 in small six-hourly steps. That slide is still unattributed in the docs; do not read it as a step change.
- **What caps the share is sales volume, not code** (catalog read 6:00 PM PT): HIGH 261 · MEDIUM 675 · LOW 731 · **ASK_ONLY 1,063** · NO_DATA 100 · STALE 6. All 1,063 ASK_ONLY renders have **0 sales in 30 days**, and 726 of the 731 LOW renders have 1–4. Like All Day's M2, almost the whole non-HIGH/MED population sits behind a volume floor.
- **Pipelines are healthy.** In the 24 h to 6:00 PM PT, every one of ~30 Pinnacle lanes ran `ok`. `pinnacle-fmv-recalc` ran 9× (last 3:37 PM PT). Sales: 179/24 h, 1,443/7 d. Live listings: 23,634. Pack opens: **91,471**, equal to Dapper's index (ledger 10-10). The last open was **10-09 9:40 AM PT**, so the zero-yield flags on `pinnacle-pack-openers` and `-metadata-backfill` are benign, a quiet drop calendar (overnight handoff 10-17).
- **Holdings names.** 12 Pinnacle wallet-cache rows are nameless or "Unknown", down from 769 before #151. A daily self-heal now runs (jobid 727, D8, ledger 10-14).

## Shipped recently (since mid-September)

- **09-26 #150:** entity surfaces (market, sniper, set/series/character/franchise) read the catalog instead of `pinnacle_editions`.
- **09-27 #151:** holdings were named from the set-level key (~31k wrong characters, 769 "Unknown"). Names now come from the catalog by render_id. **#152:** trophy slabs scoped by collection.
- **09-27 #155:** render FMV is a recency-weighted **median**. It had been a WAP-centred trim that dropped a falling render's recent sales. Same day: the serial premium was cut to #1 and perfect serials only (Trevor).
- **09-28 #156:** serials backfilled onto Limited/Legendary/Genesis sales (every 10 min). **#157:** pack EV is computed per drop, not per sub-pool; nine sub-pools at 160×–811× had led the site-wide top-EV list. **#159:** 25,793 studio-history twin sales removed ($617k double-counted).
- **09-29:** pack pulls named from sales, live listings and an on-chain read at the open block (pull-chain lane); 16.5k+ more packs priced.
- **10-03/04:** market-cap tiles on pin pages, plus character/franchise rows (#170). Atlas supply gives Pinnacle a burned / issuer-held split.
- **10-09:** young-render rule (`20261009205054`): under 7 days old with 5+ sales, a render prices at its last 5 sales; ≤ LOW under 3 days, ≤ MEDIUM on days 3–6. The backtest showed drop-day HIGH ran 1.19× where the price settled. Same day: full recalc every 3 h instead of 12 h (`20261009195532`), mints backfill switched off at the spork floor, pack-open re-price after 1 h, and three Pinnacle lanes stopped reporting ok on failed writes (ledger 10-09 ~11:05–11:15 PM).
- **10-14:** pin pages carry the collection in their title plus breadcrumbs (2,812 sitemap URLs; #66 SEO pass). Daily wallet-cache name self-heal (D8).

## Open issues

- **No Pinnacle-specific register item is open** (STATUS INDEX: 1 open · 5 partial, none Pinnacle). Estate-wide items that touch it: #66 (SEO; Search Console re-read 10-28), #114 (Cowork dashboards), #22 (credential residue).
- **Realised-sales accuracy, first measured 10-17 ~7:30 PM PT ([#193](../../reference/known-issues.md)):** overall roughly level with a naive last-3 median (14 d, n 2,008: within ±25 % 62.5 vs 66.0; dollar-weighted error 26.9 vs 30.3). ⚠ **HIGH is the weak tier:** naive median of last 5 beats it (since 10-11, n 163: 68.1 vs 74.2 within ±25 %, WAPE 31.7 vs 22.9; 45 d n 3,495: 53.9 vs 69.8). MEDIUM (76.3) beats HIGH, so the tiers do not rank in order. Cause: the 90-day recency-weighted median lags falling liquid renders; HIGH has no dispersion gate. `fmv_sales_backtest` still covers no Pinnacle rows.
- **The share leg's `rows_written 0` is the shared wrapper's convention, not a Pinnacle defect** (re-read ~7 PM PT 10-17). Every `thp-leg-*` pipeline logs 0 (18 of 18 in 24 h), because `run_thp_leg_logged` writes `0, 0, 0` for every leg (legs return void) and derives `ok` from an exception. A null instrument by construction (CLAUDE.md: `rows_written = 0` is a null instrument): judge a leg by its precompute row's `computed_at`.
- **Pull-chain cadence exemption** lapses by itself on 10-28 (`20261011151215`). Re-check on 10-26 (sessions 10-11).

## Next — prioritized

**Now**
- **#193: price HIGH-eligible renders at the median of their last 5 sales** (the young-render rule, extended). *Why:* it beat the published HIGH in every price band over 45 d and since the 10-09 engine change. *Gate:* re-measure at ≥ 500 post-10-09 HIGH sales (~2 weeks); ship only if it still wins within-±25 % and WAPE without costing MEDIUM. ✅ **Instrument shipped 10-18 ~10:20 AM PT: `pinnacle_fmv_sales_backtest(p_since, p_until)`** (`20261018171928`; reproduces #193's HIGH row exactly). Gate read: `SELECT * FROM pinnacle_fmv_sales_backtest('2026-10-09 14:00-07')`. **First read 10-18 ~10:20 AM PT: HIGH n 247 of 500; naive-5 still wins (within ±25 % 75.3 vs 64.8; WAPE 20.8 vs 31.0); MEDIUM 73.4 vs 74.7.** **A dispersion gate is not the tier-order fix** (measured ~10:34 AM PT: last-5 beats published HIGH by 9–14 pts in both tight and dispersed renders; see #193).
  - ↳ **Read 10-18 ~2:19 PM PT (Claude Code cloud, `pinnacle_fmv_sales_backtest('2026-10-09 07:00+00')`):** HIGH **n 312 of the 500 gate** (all full-5). The gap holds: published WAPE **29.9 %** vs naive last-5 **20.6 %**, within ±25 % **65.4 %** vs **75.3 %**. MEDIUM is level (18.7 % vs 19.7 %); ASK_ONLY's published price beats naive5 (21.7 % vs 41.1 %). About 33 HIGH sales a day, so the gate arrives **~10-24**; do not ship before it.
- ~~Confirm the share leg raises on a failed write~~ — **answered ~7:05 PM PT 10-17, no change needed.** Its `EXCEPTION WHEN query_canceled OR OTHERS` writes the documented failure sentinel `999` to `pinnacle_fmv_high_med_share_pct` and returns, so the wrapper logs `ok=true` on a failed leg by design (the same as `fmv_coverage` and the Panini leg). ⚠ **Key any watcher on `value = 999` (or a stale `computed_at`), never on the run's `ok`.**

**Next**
- ✅ **ATTRIBUTED 2026-10-18 ~8:00 AM PT (Claude Code cloud, read-only): sales aging out, not a code change.** Reproduced 44.7 (09-12 00:00 PT) → 27.5 (09-19 00:00 PT) from `pinnacle_fmv_history` (latest row per render as of T), falling in 12-hourly steps. **All 464 renders that lost HIGH/MEDIUM had their 30-day sales count FALL** (0 unchanged, 0 rose; MEDIUM→LOW 268, MEDIUM→ASK_ONLY 173, HIGH→LOW 15, MEDIUM→STALE 8). Positive control: 221 of the 672 renders that kept HIGH/MEDIUM had an unchanged count. The cause is the **08-14..08-22 PT `pinnacle_sales` burst** (568–1,287/day against a 30–170 baseline) crossing the 30-day edge 09-13..09-21: 71 % of the losers' sales fell on 08-13..08-19. Thresholds unchanged (LOW 1 · MEDIUM ≥ 2 · HIGH ≥ 5). No Pinnacle FMV migration or commit 09-09..09-20 (the first is `20260927203001`). **The 31.5 baseline is a post-burst level, not an unexplained step.** ⚠ Share-metric caveat: history is written only on a non-NULL FMV change, so a render that falls to NO_DATA keeps its last confidence in the share.
- (original item) **Attribute the 09-11→09-18 slide** (44.7 → 27.5) by splitting `pinnacle_fmv_history` confidence transitions per render across that week: sales aging out of the 30 d window, or a pricing change. *Why:* the stated baseline (31.5) may sit on an unexplained step. *Falsifier:* if renders that lost HIGH/MED have unchanged sales counts, it was a code change. Find it before quoting any Pinnacle trend.
- ✅ **SIZED 2026-10-18 ~8:00 AM PT: 1,044 ASK_ONLY** (`pinnacle_catalog.fmv_confidence`; today ASK_ONLY 1,044 · LOW 740 · MEDIUM 690 · HIGH 253 · NO_DATA 102 · STALE 7). 30 d: 0 with a sale (by definition). **90 d: 707 with ≥ 1, 282 with ≥ 3, 143 with ≥ 5**; 4 never sold. Every ask equals the lowest live price in the latest full `pinnacle_live_listings` snapshot. ⚠ `floor_ask_updated_at` is ONE sweep stamp on all 2,836 catalog rows, not per-ask freshness — never cite it as such. **A lever has 143–282 renders to work with, not 1,044**, and must still never re-grade an ask into MEDIUM.
- (original item) **Size the ASK_ONLY 1,063.** Find how many have *any* sale in 90 d, and whether the ask is fresh (`floor_ask_updated_at`). *Why:* it is the largest bucket. *Gate:* only a lever that moves rows with real sales counts; never re-grade an ask into MEDIUM.

**Later**
- **Drop `pinnacle_sales_studio_twins_20260928`** after 10-29 if nothing has needed it (schema-truth). Read before you drop it.
- **Finish the grain migration's ASK unification** (legacy `pinnacle_editions.ask_price` → catalog floor; [pinnacle-grain-migration-2026-07-17.md](../pinnacle-grain-migration-2026-07-17.md)). Re-derive its 07-17 counts first.
- **Next drop day:** watch young renders read ≤ LOW / ≤ MEDIUM and opens get priced within ~1 h. *Falsifier:* any render under 3 days old reading HIGH.

## Decisions on record (do not re-litigate)

- Pinnacle's HIGH/MED share is its own leg and basis. It is never averaged with, or summed into, the other collections (`lib/fmv-accuracy/fetchers.ts`; /legal/fmv-methodology says so publicly).
- Render FMV = the recency-weighted median (#155). Young-render caps (10-09). Serial premium = #1 and perfect only (Trevor 09-27).
- Pack EV is per drop, not per sub-pool (#157).
- `is_locked` is contract maturity: keep the data, no lock UI (`COLLECTIONS_WITHOUT_LOCKING`).
- A character page keys on the `characters` trait, never `character_name`. Franchise slugs drop ™.
- Writers obey the grain too: names come from the catalog by render_id (#151).
- Do **not** add a zero-yield suppression for the pack-open lanes. The 09-12 metadata-backfill failure was exactly "ok while writing nothing" (10-17 overnight).
- Estate-wide: read-only product, accuracy is the gate, no paid tier until 100 WAU, no infra spend pre-revenue, no growth tactics before the gate passes.

## Needs Trevor

- ✅ **Gate bar: DECIDED 10-17 (delegated) — no confidence-share bar.** Pinnacle's labels misrank (#193), so it is gated on realised-sales accuracy instead ([roadmap-status.md](../../reference/roadmap-status.md), "Decisions taken — the docs-refresh open list").
- Nothing Pinnacle-specific is left for him. #22 and #66 are estate-wide.

## Where the detail lives

- Grain, keys, writers, live listings, locks: [schema-truth.md](../../reference/schema-truth.md) (end)
- Defect history #4, #150–#159: [known-issues.md](../../reference/known-issues.md)
- Gate metric, by PT week: [roadmap-status.md](../../reference/roadmap-status.md) (first dated block)
- Concierge FMV triple-join: [concierge.md](../../reference/concierge.md)
- Pack opens, pulls, EV: [packs.md](../../reference/packs.md)
- Shipped changes and revert paths: [ledger.md](../../overnight/ledger.md) (09-26 → 10-17)
- Grain design (07-17): [pinnacle-grain-migration-2026-07-17.md](../pinnacle-grain-migration-2026-07-17.md)
