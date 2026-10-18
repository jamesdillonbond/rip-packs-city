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
- **Realised-sales accuracy is unmeasured.** `fmv_sales_backtest` reads `fmv_snapshots`, which holds 0 Pinnacle rows. So "accuracy against realised sales" (roadmap-status 10-10 block) covers Top Shot, All Day and Candy only. The 10-09 young-render backtest was a one-off.
- **The share leg's self-report is a null instrument.** `thp-leg-pinnacle-fmv-share` logs `rows_written 0` on every run while it does write the precompute (4/4 runs, 24 h). This is the R120 class: the count does not mean rows written. Judge it by the precompute's `computed_at`.
- **Pull-chain cadence exemption** lapses by itself on 10-28 (`20261011151215`). Re-check on 10-26 (sessions 10-11).

## Next — prioritized

**Now**
- **Build a Pinnacle realised-sales backtest** over `pinnacle_fmv_history` against the next sales per render: median absolute error vs a naive last-3 median, by confidence. *Why:* the gate has two halves and Pinnacle has only one. *Falsifier:* if MEDIUM error is no better than naive, the confidence labels are the problem, not the share.
- **Make the share leg report what it writes** (`rows_written` = 1 when the precompute row lands; pair it with `_error`). *Why:* the trust arm and pipeline watchers otherwise read a zero-writer as healthy. *Gate:* a planted failed upsert must make the run read `ok=false`.

**Next**
- **Attribute the 09-11→09-18 slide** (44.7 → 27.5) by splitting `pinnacle_fmv_history` confidence transitions per render across that week: sales aging out of the 30 d window, or a pricing change. *Why:* the stated baseline (31.5) may sit on an unexplained step. *Falsifier:* if renders that lost HIGH/MED have unchanged sales counts, it was a code change. Find it before quoting any Pinnacle trend.
- **Size the ASK_ONLY 1,063.** Find how many have *any* sale in 90 d, and whether the ask is fresh (`floor_ask_updated_at`). *Why:* it is the largest bucket. *Gate:* only a lever that moves rows with real sales counts; never re-grade an ask into MEDIUM.

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

- **Does Pinnacle get a gate bar?** M1 (Top Shot ≥ 50 %) and M2 (All Day ≥ 30 %) exist; Pinnacle has none. At ~32–34 % and volume-bound, a bar decides whether Pinnacle counts toward "the data beats the sites collectors use" or is reported beside the gate.
- Nothing else here is Pinnacle-specific. #22 (credential residue) and #66's external links (held by the gate) are estate-wide.

## Where the detail lives

- Grain, keys, writers, live listings, locks: [schema-truth.md](../../reference/schema-truth.md) (end)
- Defect history #4, #150–#159: [known-issues.md](../../reference/known-issues.md)
- Gate metric, by PT week: [roadmap-status.md](../../reference/roadmap-status.md) (first dated block)
- Concierge FMV triple-join: [concierge.md](../../reference/concierge.md)
- Pack opens, pulls, EV: [packs.md](../../reference/packs.md)
- Shipped changes and revert paths: [ledger.md](../../overnight/ledger.md) (09-26 → 10-17)
- Grain design (07-17): [pinnacle-grain-migration-2026-07-17.md](../pinnacle-grain-migration-2026-07-17.md)
