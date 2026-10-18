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

## Open issues

- **Pre-2023-11-08 Top Shot custodial pack opens are missing** for 33 of 34 saved wallets (#190). Declined: every free source is ruled out, and the keyed ones are infra spend.
- **Top Shot rips mostly have no pack NFT** (packs.md). Attribution relies on Dapper's index identity. A GUESSED drop was wrong 12.6 % of the time (10-10), so anything still guessed is suspect.
- **EV is a lower bound wherever FMV coverage is below 100 %.**
  - `pack_grail_metrics` counts an unpriced edition as $0. The UI says "≥", but every reader must too.
  - All Day and Golazos pools inherit those collections' thin confidence (M2 26.4 %).
- **Supply feed health:** `topshot-pack-supply-atlas` fails ~26 % of its runs (chronic, Cloudflare 403s), and `pack-mint-probes` `failure_rate` is expected to stay lit (#166). A stale "as of" is the honest output.
- **Measured but unshipped:** `compute_pack_ev_per_edition_weighted`'s `fmv_current` leg. The stakes are LOW at the real per-dist call sites (~2.6 k buffers/call). It re-seeds a pinned fixture, so it is Trevor's call.
- **`RPCGiveawayPacks` contract:** not deployed. It needs an audit and a dedicated deploy account. #172 (desktop extension stall) is shelved: deliver from the phone.

## Next — prioritized

**Now**
1. **Owed 2026-10-20 ~7 PM PT: verify Series 2026-27 pack ingest end to end.** Check pack labels, Atlas dist counts and EV rows for the first Series 9 drops. Why: launch is when traffic and new dists both arrive. Falsifier: a new dist with no `topshot_atlas_dists` row or no EV within a few hours of going on sale.
2. ✅ **AUDITED + FIXED 2026-10-18 ~9:10 AM PT (Claude Code cloud).** The grep did NOT return 0: three live surfaces, all fixed this pass.
   - `get_pack_for_simulator` sent an unpriced pull as `fmv_usd: 0` (1,210 of 220,316 pullable pool rows, 436 dists), so the simulator's own coverage disclosure could never fire → now NULL (`20261018155545`; verified: a sample dist returns 4 null, 0 zero).
   - `pack_grail_metrics` `prob_grail_{25,100,500,1000}_per_slot` count an unpriced edition as "not a grail" (435 of 5,478 dists partial, 267 at zero coverage) → the simulator's ProbCards and `GrailsView` now show "≥ x%" below full coverage and "—" with nothing priced (`fmvProbQualifier`, lib/grail-format.ts). The view itself is unchanged (no repo migration defines it).
   - The Discord/Telegram `soldpacks` digest printed pulled value and Net P/L as complete while unvalued rips count $0 and unpriced drops add $0 spend → `packReportFigures` marks each "≥"/"≤" with the valued count, and publishes no P/L when partial both ways; a failed summary read now answers "Couldn't load" instead of "No pack history found" (Telegram had answered with silence).
   - **Latent, not fixed (write side):** `compute_pack_ev_from_pool` stores a missing pack price as `pack_price=0` → `is_positive_ev=true` (2,542 latest All Day/Golazos/Pinnacle rows). Every reader checked neutralises it (`pack_ev_latest`, `pack_table_rows`, `analytics_packs_summary`'s `BETWEEN 1 AND 5000`); one unguarded reader away from a false "+EV".
   - (original item) **Audit every EV/pull reader for the `COALESCE(…,0)` shape** that fabricated Pack Reality's 11 %. Grep the expression, not the file. Why: one instance was found, and it spread by copy-paste. Falsifier: the grep returns 0 live sites.

**Next**
3. **Pack-history cold latency.** 2 of the 6 heaviest wallets exceeded the 8 s budget cold (10-11). Re-measure after v23 and fix only on buffers. Gate: a real wallet's summary times out in the production caller.
4. ✅ **SHIPPED 2026-10-18 (Claude Code cloud): the packs board's Depletion % now states its age** ("as of 111d ago", from `pack_table_rows.depletion_as_of`), and a figure with no stamp says "age unknown" — read live 10-18: All Day's supply stamps have a median of **06-29**, and Pinnacle's 138 depletion figures carry **no stamp at all**. The dist page already dated every number (`lib/pack-dist/as-of.ts`). **Still open:** give Pinnacle's `pack_distributions.depletion_pct` a writer-side stamp so "age unknown" can become an age.
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
