# Handoff — NFL All Day pack lifecycle: what's possible, what's blocked (2026-06-28, Cowork)

I tried to build the AllDay supply lifecycle from Cowork and **found the supply API can't give depletion** — so AllDay genuinely needs a worker change. Here's the verified reality and the path.

## What I built live (Cowork)

`allday_pack_supply` (table, RLS on, anon SELECT) — per-dist AllDay **drop size** from the Dapper Studio Platform `searchDistributions(byProductID "AllDay")` API (reachable from Supabase egress, no proxy). `dist_id = String(node.id)` (matches `pack_distributions`/`pack_ev_latest`). 1,360 dists, `total_minted = totalSupply` is **reliable** (e.g. Grail Seeker 48,050, Regal Rookie Airdrop 40,000). Edge fn `backfill-allday-pack-supply` (deployed, gated `?key=`, no cron). **Revert:** `DROP TABLE public.allday_pack_supply;` + the edge fn is inert (gated, unscheduled).

## The blocker (verified, not assumed)

AllDay's `searchDistributions.availableSupply` is **degenerate — it equals `totalSupply` for all 1,360 dists**, so opened/opened-vs-sealed/depletion are all 0. This is corroborated by the existing AllDay EV pipeline: only **7 of 521** AllDay EV rows show `depletion_pct > 0`. And there's no event-stream fallback: **0 AllDay `pack_rips`** and only **1** AllDay dist with `primary_mint` purchase events. So the columns `total_opened`/`total_sealed`/`depletion_pct` on `allday_pack_supply` are deliberately **NULL** (don't render them).

Bottom line: AllDay has drop sizes but **no opened/sealed/depletion and no realized-pull data from any current source.** Unlike Top Shot (where `getPackListing.packListingContentRemaining` gives true unopened), the AllDay distribution API only exposes the static drop size.

## The path — Phase 2 (worker + view generalization; can't be done from Cowork)

**2a — Ingest AllDay pack opens.** The `pack-events-ingest` worker indexes Top Shot pack opens (`topshot_pack_opens` cursor) but not AllDay. AllDay packs are still opened on-chain (`A.e4cf4bdc1751c65d.PackNFT`). Add an AllDay pack-open/reveal cursor: **verify the event signature with the Cadence MCP first** (fetch the deployed `PackNFT` contract source — don't trust training data), then index opens → write `pack_rips` (collection_id = AllDay) + the pulled moments to `moment_acquisitions` with `source_pack_rip_id`, mirroring the TS path. A historical backfill walks the open events back as far as the spork allows.

**2b — Generalize the lifecycle/EV views to AllDay.** The Top Shot views (`v_topshot_pack_lifecycle`, `v_topshot_pack_realized_ev`, `v_topshot_edition_pull_provenance`, `v_topshot_pack_ev_calibrated`) **hardcode the TS collection_id** — they won't pick up AllDay automatically. Once AllDay rips exist, either parametrize them by `collection_id` (a generic `v_pack_lifecycle(collection_id)` family) or clone the AllDay variants. The attribution resolver (`backfill_pack_rip_metadata`) is already collection-scoped and AllDay has `pack_drop_pool` rows (89,778), so per-dist attribution would work as soon as rips land. Use `allday_pack_supply.total_minted` as the per-dist drop-size denominator (opened-share = pulls / drop size).

**Priority note:** AllDay ended *primary* pack sales, so this is the historical-open tail, not live drops — lower ROI than Top Shot. Worth it if AllDay pack-reality/provenance becomes a priority; otherwise the drop-size table stands alone as a supply reference.

## Guardrails
Direct to `main`, no PRs. Verify the Cadence event signature via the MCP before writing the indexer. Worker deploys are manual `wrangler` (not git push) — check deployed-vs-HEAD. New views: `security_invoker` + anon-SELECT.
