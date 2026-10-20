# Pack EV — feature roadmap (refreshed 2026-10-17, PT)
> Dated snapshot; re-derive any number before quoting. Canonical plan: [roadmap-2026-10-17.md](../roadmap-2026-10-17.md). Per-collection detail: [collections/](../collections/). Defects: [known-issues.md](../../reference/known-issues.md).

## What it is today

Pack intelligence answers one question for each collection: what is left in a drop, and what is it worth? It has four parts:
- **Remaining pool.** Top Shot reads Dapper's live per-dist counts from the Atlas `DistributionService` lane (`topshot_atlas_dists`). Pinnacle pools come from Studio `searchDistributions` at drop grain.
- **EV.** Each dist's pool edition is priced from the latest FMV. Writers: `compute-topshot-pack-ev`, `compute-allday-pack-ev`, `compute-golazos-pack-ev` (pg_cron 44) and DB-side `refresh_atlas_pack_ev`. Panini has its own models: guaranteed-contents EV (hourly, jobid 723) and a WNBA sales model.
- **Pack history / rips.** `get_wallet_pack_history` (v23) and `get_wallet_pack_summary` cover rips, purchases, held packs and P/L. The rip↔drop identity comes from Dapper's index, backfilled for all 697,955 Top Shot rips (10-10/11).
- **Public boards and tools.** Pack Reality, the pack-market boards, Pack Drops, the Pack Simulator, and the pack-dist page's "What drives the remaining EV".

Three values must never be labelled as one another (packs.md 09-26): the EV of what is left, what a rip actually yielded, and retail price.

## Shipped recently (since mid-September)

- **09-28 #157:** Pinnacle EV is computed per DROP, not per sub-distribution. The 160×–811× "top EV" chase pools are gone.
- **10-02:** WNBA (Panini) pack EV priced from sales with a player × parallel model, hourly.
- **10-03:** Atlas `DistributionService` became the live Top Shot supply source.
- **10-04:** pack purchases re-keyed to the chain, and the chain-identity backlog drained to 0.
- **10-10:**
  - **#65:** Top Shot pools are synced from Atlas, and EV covers **777 dists, up from 57**.
  - `compute-topshot-pack-ev` no longer deletes a pool before writing its replacement.
  - **#187:** a pack out of a box is no longer priced as bought ("From a box").
  - **#188:** boxes, cases, toppers and premium packs get an EV, with uuid-less dists keyed by `dist_id`.
  - **#88:** the share card shows PACKS UNOPENED.
  - Anonymous `/api/pack-ev` calls no longer write EV history (#180).
- **10-10 Panini:** guaranteed-contents EV (23 of 344 packs priced, up from 4; 0 positive rip edges) and `/insights/panini-premiums`.
- **10-11:** the last 122 disagreeing Top Shot rips re-keyed. Pack-history v23 decides status before enrichment. The Pack Simulator marks EV/slot "≥" below 100 % FMV coverage.
- **10-14:**
  - Top Shot pack pages show live Atlas counts (e.g. dist 5048 "134 of 22,068 · 17h ago", previously frozen at 08-28).
  - **Pack Reality's "11 % delivered nothing" was 100 % fabricated.** `COALESCE(pull_value_usd, 0)` counted 7,012 unpriceable rips as $0 pulls; fixed.
- **10-15/16:** `refresh_pack_market_sales_cache` recomputes dists that SOLD first. `backfill_pack_rip_metadata` buffers fell 4.28 M → 453 k a run (but the run is disk-bound, so wall time fell only ~10 %).
- **Giveaways (10-03/04).** Claim pages open packs card by card. Winners can claim with Flow Wallet using an account proof. Delivery stays the sponsor's admin-signed Deliver all, the one read-only exception.

- **10-18 ~8:10 PM PT (Cowork cloud):** Pack Net P&L counts packs with no buy row (inferred drop cost) in its spend-coverage floor, and the Collection tab's Packs view now withholds on the same rule — it had published per-collection Net P&L with no check (ledger 10-18; `57e945a`).

## Cross-collection parity (2026-10-19 ~7:30 PM PT, Claude Code cloud)

Shipped this pass (ledger 10-19):
- **Golazos dist page:** observed lifecycle and realized pull value (`v_golazos_pack_lifecycle`, complete open history: 78,830 = the index total).
- **All Day and Golazos dist pages:** "What drives the remaining EV" (`get_pack_ev_contributors` 3-arg, takes the collection).
- **Golazos single-pack page** `/laliga-golazos/pack/<id>`: `get_golazos_pack_lifecycle`.
- ⛔ **PackNFT ids are per-contract.** 2,294 Golazos pack ids are also the ids of different All Day rips. Every single-pack read is now collection-scoped (`lib/pack-detail/lifecycle-rpc.ts`).
- **Collection tab "Packs" column** reads the collection's own PackNFT type (TS/AD/Golazos). It used to read Top Shot's packs on every collection. Collections with no source show no column.
- **Pinnacle pack rows** link to no simulator (0 `pack_drop_pool` rows).
- **Panini and Candy pack boards** link out: Panini packs to their nft.paniniamerica.net page, Candy asks to Magic Eden.

Still open, with the reason each one waits:
- **Golazos / Pinnacle sealed resale and pack sales history:** no secondary data. `golazos_pack_sales_history` is drop (primary) sales only, ending 2023-04. Pinnacle has 0 pack buys.
- **Pack Sniper beyond TS/AD:** Golazos had 1 collector-listed dist (read 10-19). Pinnacle has no Flow listing feed.
- ~~**Pinnacle single-pack page.**~~ ✅ Shipped 10-19 (`get_pinnacle_pack_lifecycle`). Its pulls are named by the pricing lane's own ladder (300 random multi-pull packs: 990 pulls, 0 unnamed). ⚠ **Correction:** the reason recorded here earlier ("the opener is the platform custodian for ~99 % of opens") was WRONG. There are 5,577 distinct openers, and the custodial account `0xedf9df96c92f4595` opened 11,851 of 91,471 (13 %). The 99.3 % figure is the share of *that account's* opens that are platform batches.
- **Pinnacle pack pages list the pins in each drop** (`get_pinnacle_dist_contents`), from `metadata.edition_ids`. Measured 10-19: 27,900 of 27,900 named pulls are on their drop's list. Each pin shows its OBSERVED pull share, labelled as measured and not as odds.
- ✅ **Golazos pack buy links: closed, because no destination exists** (measured 10-19 ~10:20 PM PT via `pg_net`). laligagolazos.com links only `/marketplace/moments`. Every pack-path guess returns 404 (`/packs/<dist>`, `/pack/<uuid>`, `/drops/<uuid>`, `/marketplace/packs/<uuid>`, `/listings/pack/<uuid>`, `/packs`, `/marketplace/packs`), and `lib/collections.ts` already records that Golazos has no packs on dapper.market. Reopen if Golazos launches a pack marketplace.
- ⛔ **Upstream gaps, measured 10-19 ~10:15 PM PT through Studio `searchDistributions` (byProductID Pinnacle, via `pg_net`):** across the first 100 of 156 distributions, `images` is empty for every one and `packOdds` is empty for every one. Dapper does not publish Pinnacle pack art or pack odds, so Pinnacle surfaces read "Image unavailable", and the observed share is the only pull-rate measure. Re-check only if Dapper's Pinnacle drop pages start showing odds.
- Pack-page pull cards now link `/laliga-golazos/edition/<external_id>` and `/pinnacle/moment/<render_id>`. `/moment/<nft_id>` 404'd for both collections because neither has rows in `moments`.
- **Pinnacle simulator, grails and top pulls:** blocked on a drop pool. EV is render-pooled per drop (#157), and no table holds the pool.
- ~~**`/analytics/packs`** lists UFC, which has no packs, and omits Panini and Candy.~~ ✅ 10-19: UFC removed; Panini and Candy panels link to their own pack boards. Their models are not in `analytics_packs_summary`.
- **Insights pack-reality and pack-market boards** are TS/AD only. A Golazos realized board would have no modeled side, because pulls are priced years after the open.

## Open issues

- **Pre-2023-11-08 Top Shot custodial pack opens are missing** for 33 of 34 saved wallets (#190). Declined: every free source is ruled out, and the keyed ones are infra spend.
- **Top Shot rips mostly have no pack NFT** (packs.md). Attribution relies on Dapper's index identity. A GUESSED drop was wrong 12.6 % of the time (10-10), so anything still guessed is suspect.
- **EV is a lower bound wherever FMV coverage is below 100 %.**
  - `pack_grail_metrics` counts an unpriced edition as $0. The UI says "≥", but every reader must too.
  - All Day and Golazos pools inherit those collections' thin confidence (M2 26.4 %).
- 📏 **`/api/packs` Top Shot calibrated merge costs ~3.3 s per call, measured 10-18 ~6:15 PM PT (Claude Code cloud; not shipped).** `pg_stat_statements`: 439 calls, mean 3,283 ms, max 27 s, ~106k buffers per call; Vercel logs 2 `read exceeded 8000ms` hits in 48 h. Cause: `v_topshot_pack_ev_calibrated` reads `pack_ev_latest`, a `DISTINCT ON (pack_listing_id)` over all ~666k `pack_ev_history` rows (60 MB external sort per call); the Top Shot filter cannot push below the `DISTINCT ON`. The fix the All Day branch used (`v_allday_pack_detail_ev`, a 0-row EXCEPT diff) does NOT transfer cleanly. Rebuilding the merge from `v_topshot_pack_realized_ev` (MV-backed) plus the board row's own `ev_pack_price` gives 306 applied dists against the view's 216. 5 differ only on price: the view takes the newest row across a dist's listings, not the price the board row shows; e.g. dist 1202 is $2.00 in the view vs $4.00 on the board. The 90 extra have a realized calibration but no `pack_ev_latest` row, plausibly withheld by its `gross_ev > 3 × lowest_ask` guard. **Checked the same pass: `calibrated_ev` DOES blend the modeled `gross_ev`** (`mv_topshot_pack_realized_ev`: `(1 − w) × modeled + w × realized_winsorized`, w = min(0.85, n/(n+40)); realized-only when the modeled EV exceeds 3 × the realized mean). So before admitting the 90, confirm the MV's modeled leg cannot carry an EV the board's ask guard withheld. Then decide whether net/margin should use the board row's price (more consistent with the row) or the view's.
- **Supply feed health:** `topshot-pack-supply-atlas` fails ~26 % of its runs (chronic, Cloudflare 403s), and `pack-mint-probes` `failure_rate` is expected to stay lit (#166). A stale "as of" is the honest output.
- 📏 **All Day pack-page latency, diagnosed 10-18 ~1:02 PM PT (not acted on):** the occasional `allday_pack_lifecycle` / `pack_realized_ev` 5 s timeouts on `/[collection]/pack/dist/[distId]` come from `pack_rips`' visibility map. `EXPLAIN (ANALYZE, BUFFERS)` of `v_allday_pack_lifecycle` for dist 6924: 691 ms, of which 683 ms is an index-only scan on `idx_pack_rips_dist_agg_v4` doing **715 heap fetches for 1,887 rows** (353 cold reads). `pack_rips` (2.3 GB) is only **72.1 % all-visible**; autovacuum last ran 10-16 and dead tuples are 1.5 %, under its 2 % trigger, with a deliberate cost limit of 50. ✅ **Acted on 1:03 PM PT (decided under Trevor's "make decisions"):** pg_cron job 750 `maint-vacuum-pack-rips` runs `VACUUM (ANALYZE) public.pack_rips` daily at 4:37 AM PT (`20261018200339`), the same pattern as `maint-vacuum-panini-card-serials`; the 08-28 one-shot took 33.6 s. **Read 10-19 after 4:37 AM PT:** `relallvisible / relpages` ~99 %, and the dist-6924 EXPLAIN's Heap Fetches near 0. Revert: `SELECT cron.unschedule('maint-vacuum-pack-rips');`.
  - ✅ **Measured 10-19 ~7:05 AM PT after the first `maint-vacuum-pack-rips` run (pg_cron 750, 4:37 AM PT, `succeeded VACUUM`):** `pack_rips` relallvisible/relpages **72.1 % → 100.0 %** (98,747 / 98,747). `EXPLAIN (ANALYZE, BUFFERS) select * from v_allday_pack_lifecycle where dist_id='6924'`: index-only scan heap fetches **901 → 95**, buffers **674 → 99** (hit 46 / read 53), **285 ms → 14.7 ms** (baselines: the overnight pass's 01:13 AM PT pre-vacuum read; the 10-18 691 ms / 715 was a different moment). The residual 95 fetches are pages written since 4:37 AM; the daily vacuum keeps them bounded. Watch: the `allday_pack_lifecycle` / `pack_realized_ev` 5 s timeouts on pack pages should stop appearing in Vercel runtime errors.
  - 📏 **Watch read 10-19 ~12:15 PM PT (Claude Code cloud): 0 pack-page 5 s timeouts since the vacuum, vs 2 in the 24 h before — consistent, NOT yet evidence.** Vercel runtime logs (production, full-text): `allday_pack_lifecycle` 1 in 10-18 4:40 AM → 10-19 4:37 AM PT (`/nfl-all-day/pack/dist/4370`, 12:38 PM PT), 0 since; `pack_realized_ev` 1 (`/nba-top-shot/pack/dist/7628`, 10-18 7:06 PM PT — a Top Shot page, which this vacuum does not obviously serve), 0 since. The base rate is ~1/day, so a 7.5 h zero means little; re-read over ≥ 3 post-vacuum days before calling it closed. Query each term separately, scoped by `since`/`until` (a 3-day window timed out).
- ~~**Measured but unshipped:** `compute_pack_ev_per_edition_weighted`'s `fmv_current` leg.~~ ✅ **STALE LINE, corrected 10-18 ~12:14 PM PT: it shipped 2026-08-30** (`20260830152806`: the pool reads the latest snapshot per edition through a LATERAL, not the `fmv_current` view). Measured 10-18 on All Day dist 6924: 9,528 buffers, 127 ms per call. The ~176 k blocks/call average in `pg_stat_statements` pools two months that include the pre-fix era (stats reset 08-11), so it is not today's cost.
- **`RPCGiveawayPacks` contract:** not deployed. It needs an audit and a dedicated deploy account. #172 (desktop extension stall) is shelved: deliver from the phone.

## Next — prioritized

**Now**
1. **Owed 2026-10-20 ~7 PM PT: verify Series 2026-27 pack ingest end to end.** Check pack labels, Atlas dist counts and EV rows for the first Series 9 drops. Why: launch is when traffic and new dists both arrive. Falsifier: a new dist with no `topshot_atlas_dists` row or no EV within a few hours of going on sale.
2. ✅ **AUDITED + FIXED 2026-10-18 ~9:10 AM PT (Claude Code cloud).** The grep did NOT return 0: three live surfaces, all fixed this pass.
   - `get_pack_for_simulator` sent an unpriced pull as `fmv_usd: 0` (1,210 of 220,316 pullable pool rows, 436 dists), so the simulator's own coverage disclosure could never fire → now NULL (`20261018155545`; verified: a sample dist returns 4 null, 0 zero).
   - `pack_grail_metrics` `prob_grail_{25,100,500,1000}_per_slot` count an unpriced edition as "not a grail" (435 of 5,478 dists partial, 267 at zero coverage) → the simulator's ProbCards and `GrailsView` now show "≥ x%" below full coverage and "—" with nothing priced (`fmvProbQualifier`, lib/grail-format.ts). The view itself is unchanged (no repo migration defines it).
   - The Discord/Telegram `soldpacks` digest printed pulled value and Net P/L as complete while unvalued rips count $0 and unpriced drops add $0 spend → `packReportFigures` marks each "≥"/"≤" with the valued count, and publishes no P/L when partial both ways; a failed summary read now answers "Couldn't load" instead of "No pack history found" (Telegram had answered with silence).
   - ~~**Latent, not fixed (write side):** `compute_pack_ev_from_pool` stores a missing pack price as `pack_price=0` → `is_positive_ev=true` (2,542 latest All Day/Golazos/Pinnacle rows). Every reader checked neutralises it (`pack_ev_latest`, `pack_table_rows`, `analytics_packs_summary`'s `BETWEEN 1 AND 5000`); one unguarded reader away from a false "+EV".~~ ✅ **FIXED 10-18.** The edge writers stopped writing zero-price +EV rows at ~9:37 AM PT (`c6572c45c` in the shared helper; `compute_pack_ev_per_edition_weighted` already gated). The two SQL siblings `compute_pack_ev_from_pool` / `_tier_weighted` (reached by the concierge's `mcp_compute_pack_ev`, where `retail_price_usd` is `0` on 1,337 dists) now require a price > 0 too (`20261019002658`, ~5:55 PM PT; verified: price 0 → false, $0.01 → true). Historical rows are unchanged (the readers neutralise them).
   - (original item) **Audit every EV/pull reader for the `COALESCE(…,0)` shape** that fabricated Pack Reality's 11 %. Grep the expression, not the file. Why: one instance was found, and it spread by copy-paste. Falsifier: the grep returns 0 live sites.

**Next**
3. ✅ **CLOSED 2026-10-18 ~10:00 AM PT (Claude Code cloud) — no production timeout.** Re-measured after v23 (EXPLAIN ANALYZE, BUFFERS): the heaviest SAVED wallet (0xf77b…, ~1.02M buffers) is 4.6 s cold / 1.8 s warm, under the 8 s `boundedRead` budget. The two cold over-budget wallets (0x6407… 12.1 s, 0xe068… 9.9 s) are saved by nobody, and the dashboard routes 403 an unsaved wallet, so the production caller cannot reach them. Vercel: 0 pack-summary/pack-history errors in 7 d (positive control: other "read exceeded 8000ms" groups are visible). Warm buffers on 0x6407 (658k) match 10-11, so v23 held; the 10-11 "15.4 s cold" was an instrument artifact (retracted in the ledger that day). **Reopen if** a saved wallet logs `RPC_READ_TIMEOUT`; the lever is ~150k per-row index probes (`pack_nft_identity`, `pack_distributions`, `allday_pack_supply` via `pack_retail_usd` / `allday_pack_primary_minted_at`): compute once per drop, judge on buffers. ⚠ The Discord/Telegram `soldpacks` report takes ANY pasted wallet and has no 8 s budget (~12 s cold for a whale); nothing logged in 7 d.
   - (original item) **Pack-history cold latency.** 2 of the 6 heaviest wallets exceeded the 8 s budget cold (10-11). Re-measure after v23 and fix only on buffers. Gate: a real wallet's summary times out in the production caller.
4. ✅ **SHIPPED 2026-10-18 (Claude Code cloud): the packs board's Depletion % now states its age** ("as of 111d ago", from `pack_table_rows.depletion_as_of`), and a figure with no stamp says "age unknown" — read live 10-18: All Day's supply stamps have a median of **06-29**, and Pinnacle's 138 depletion figures carry **no stamp at all**. The dist page already dated every number (`lib/pack-dist/as-of.ts`). **Still open:** give Pinnacle's `pack_distributions.depletion_pct` a writer-side stamp so "age unknown" can become an age. ⚠ Not `pd.updated_at`: Pinnacle rows have TWO writers (`metadata.source` `studio_platform_gql` and `pds_contract`; oldest `updated_at` 09-25, read 10-18), so that column is not the age of the depletion read. The stamp has to come from the lane that computes it (`compute-pinnacle-pack-ev` writes `total_opened` from `availableSupply`), e.g. a `metadata.supply_as_of` it sets, then a `pack_table_rows` branch reading it.
   - (original item) **Pinnacle and All Day remaining-pool freshness.** Put a dated "as of" on every pool surface, as Top Shot now has. Falsifier: any pool rendered without its source age.

**Later**
5. **Rookie Debut (2026-11-11) packs.** The rookie class must be rebuilt from Series 9 sets before the rookie-pack boards use it. Do not seed it from the draft (roadmap-status 10-17).
6. **Giveaway contract**, only if Trevor gives the §9 go-ahead (audit → deploy account → deploy). Nothing user-facing is blocked meanwhile.

## Decisions on record (do not re-litigate)

- **RPC Packs (selling RPC's own re-packs) is SHELVED** (07-19, "Declined — do not re-suggest"). The 09-29 reassessment re-measured the market at ≈ $755 lifetime and went quiet after 08-06.
- **Free packs are giveaways under the one admin-signed read-only exception** ([concierge.md](../../reference/concierge.md)). Only the recipient can open a pack, there is no 14-day rule (10-03), and the winner chooses the destination at open.
- **#190 declined** (10-17): no paid source for pre-2023 opens. Reopen with revenue or a paying user's ask.
- **#172 shelved** (10-17): the phone is the delivery path.
- **Do not extend `topshot_normalize_circulation` to Series 9** (/500 Rookie Debut vs its 1,000 floor).
- **A pack out of a box carries no buy price** (#187): its cost is part of the box's price.

## Where the detail lives

- Mechanics, sources, boxes, spork nodes: [packs.md](../../reference/packs.md).
- Free packs and giveaways: [free-packs-reassessment-2026-09-29.md](../free-packs-reassessment-2026-09-29.md) (§9–§10.1). Repack history: [repack-drops-feature-scope-2026-06-19.md](../repack-drops-feature-scope-2026-06-19.md).
- Panini pack EV method: [panini-fmv-packev-methodology.md](../panini-fmv-packev-methodology.md).
- Series 9 readiness: [roadmap-status.md](../../reference/roadmap-status.md) ("SERIES 2026-27 LAUNCH READINESS").
- Register: #65, #88, #157, #166, #172, #187, #188, #190 in [known-issues.md](../../reference/known-issues.md).
