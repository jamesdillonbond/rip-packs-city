# The pack-reality drain is a dead POOL source, not a dead ASK source — and the pool does not need refreshing

**Filed 2026-08-30 ~02:30Z (08-29 19:30 PT), Cowork desktop-VM session. Refines known-issues #50 and the view comment `20260829202158`, which said "no writer to chase". There is one, and it is green.**

## The chain, measured

1. `topshot_pack_reality_top_ev` reads `pack_ev_latest` with `snapshotted_at >= now() - 48h`, `depletion_pct < 90`, `fmv_coverage_pct >= 40`, `is_positive_ev`.
2. `pack_ev_history` for Top Shot has TWO writers. Fingerprinted by minute: the `:25` writer is `refresh_atlas_pack_ev()` (pg_cron jobid 217) and covers exactly the **57** `pool_source='atlas'` dists (pool last refreshed 07-17) — **it has never produced a positive-EV row** (0 of 1,120 on 08-29). The other writer, one row per dist spread through the day, covered **495–706 dists/day** and carried **all** the positive-EV rows (27/24/21 on 08-26/27/28). Its last row is **2026-08-28 16:38:02Z** — the same instant as `pack_drop_pool.last_refreshed_at` for every `gql` row.
3. That writer is **`compute-topshot-pack-ev`** (edge fn). It has run every ~6 min since (1,216 of 1,333 ticks `ok: true`) and written **zero rows in 33 hours**: every tick reads `gql_errors: 4, nodes_processed: 4, ev_rows_written: 0` with `rows_skipped = rows_found`. It is the sixth pipeline in the 08-29 16:30Z filing's class — **`ok: true` through a total failure** — and no watchlist arm sees it because the `:25` atlas rows keep the pipeline-level freshness green.
4. Its GQL is `getPackListing { packEditionsV3 }` on **`public-api.nbatopshot.com`** — the host that has returned Cloudflare 530/1033 since 08-28 ~17Z (decommissioning-shaped per the 16:30Z filing). Studio is used only for the ask map.

## What Studio can and cannot replace (introspected live 02:0x–02:2xZ from the cloud container)

- ✅ **Asks: yes, already.** `searchPackNftAggregation` with the repo's `STUDIO_SEALED_FILTERS` returns **1,995** sealed DUC-listed Top Shot packs keyed by `dist_id` with `listing.price.min` and `distribution.number_of_pack_slots` — this is what `snapshot-pack-asks` already writes to `pack_ask_state` every 5 min (751 of the 767 `gql`-pool dists have a live ask right now).
- ❌ **Pack contents: no.** `searchDistributions` exposes `editionIds` and `packOdds` on the `Distribution` type, but for every Top Shot distribution sampled (27 of 27, typename `A.0b2a3299cc857e29.PackNFT.NFT`) both are **empty**; `getCollectiblesDistributionDetails` answers `unauthorized`. `byIDs` keys on Studio's internal id, not `dist_id`.
- ❌ **Depletion: not through this path.** `PackDistributionAggregation.total_minted / total_burned` exist but the loader refuses ("total burned is not supported if the type_name is not resolved") even with `dist_id`, `distribution.id` and node `type_name` as aggregation keys.

## The design that follows, and why it is honest

**The pool of a Top Shot distribution is fixed at drop.** `pack_drop_pool` holds it for 767 `gql` dists (plus 1,161 `gql_historical`). What moves is the ask (live from Studio) and depletion (packs opened). So EV can keep running **without the dead host**:

- a pg_cron job in the shape of `refresh_atlas_pack_ev()` over `pool_source = 'gql'`, pricing from `pack_ask_state.lowest_ask` (live), computing EV with `compute_pack_ev_per_edition_weighted()` exactly as today;
- **depletion from our own on-chain ingest**, not carried forward: `pack_rips` / pack-opens per dist against the last known minted total, so a pack that sold out since 08-28 is not published as 82% depleted. Until that leg exists, revived rows must carry `depletion_pct = NULL`, which the top-EV view's `COALESCE(…, 100) < 90` correctly EXCLUDES — i.e. the board stays empty rather than wrong, and pack pages get fresh EV with an explicit "supply unknown" state.

**Cost, measured not guessed:** jobid 217 averages 166 s for 57 dists (~3 s/dist; 6 of 72 runs hit the 600 s ceiling). 751 dists ≈ 37 min of DB time per full cycle on an IO-bound instance. A rotating 100-dist tick hourly (~5 min) refreshes every dist ~8-hourly. **That is an IO-budget decision (R46) and a product decision (which dists, what to show while depletion is unknown) — Trevor's — which is why nothing shipped here.** The 77 dists that were `depletion < 90` at their last snapshot are the cohort that could ever reach the board; a cohort-only job is atlas-sized.

## Also owed, independent of the design

`compute-topshot-pack-ev` should log `ok: false` when `gql_errors = nodes_processed` and `ev_rows_written = 0` — it is a 33-hour outage that no instrument reports. Same fix shape as the 16:30Z filing asked for across the class.
