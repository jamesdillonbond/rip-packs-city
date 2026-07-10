# Claude Code prompt — surface AllDay pack lifecycle / realized EV / provenance (2026-06-29)

The AllDay pack-mechanics **data layer is now at Top Shot parity** (built across several Cowork sessions, all DB-side live via MCP). What's left is the **frontend route work** Cowork can't push: wiring the live views into pages. All backing views are `security_invoker` + anon-SELECT; `check_public_security_invariants()` = 0. Direct to `main`, no PRs. Mirror the existing Top Shot pack surfaces.

## Live backing views (all AllDay, collection_id `dee28451-5d62-409e-a1ad-a83f763ac070`)

- **`v_allday_pack_info`** — per dist: drop_size, slots, pack_price, modeled (canonical) EV, **corrected EV** (`corrected_gross_ev`/`corrected_net_ev`/`corrected_value_ratio`/`ev_method`/`has_published_odds`/`stale_value_share_pct`/`low_confidence_ev`). Corrected EV is already adopted on the dist page / `/api/packs` / OG (CC `f5595fa`,`d279d83`) — reuse the same pattern for anything below.
- **`v_allday_pack_lifecycle`** — per dist: `packs_opened`, `moments_pulled`, `realized_pull_value_usd`, `avg_realized_value_per_pack`, **`opened_pct_of_minted`** (depletion), `opened_7d/30d`, first/last_open. **`v_allday_pack_lifecycle_global`** — aggregate (currently 128+ opened / ~99% valued / ~$1,760 realized / ~$13.86 avg).
- **`v_allday_edition_pull_provenance`** — per edition: `pack_pulls_observed`, `distinct_packs`, `observed_pull_share_pct`, first/last pull (235 editions now, growing).
- **`v_allday_pack_realized_ev`** — per dist: `modeled_gross_ev` (corrected) vs `realized_mean`/`realized_median`/`realized_to_modeled_ratio`, `n_opens`, `low_confidence_ev`. The AllDay reality-check (mirrors `v_topshot_pack_realized_ev`).

## Items to build (frontend)

1. **AllDay pack lifecycle strip on the dist/packs page.** Mirror the Top Shot "Observed pack lifecycle" strip but read `v_allday_pack_lifecycle`: show `opened_pct_of_minted` (depletion), `packs_opened`, `avg_realized_value_per_pack`. Guard the per-dist row on `packs_opened > 0` (dist attribution is still filling — see caveats), so dists with no attributed opens just hide the strip rather than show "0 opened / 0% depletion".

2. **Edition-page pack provenance for AllDay.** Mirror the Top Shot edition "Pack provenance" stat using `v_allday_edition_pull_provenance` (`pack_pulls_observed`, `observed_pull_share_pct`). **Copy caveat:** window-bounded (opens ingested since ~2026-06-28) → label "observed since June 2026", show as directional, not a precise fraction.

3. **AllDay cut of `/insights/pack-reality` (or a sibling).** Read `v_allday_pack_realized_ev` — "model says $X, packs actually pull $Y". Run the `rpc-insights-qa` checklist (sitemap, OG via a route handler, param-stripped canonical, freshness chip, no hardcoded `#E03A2F`). Gate on `n_opens >= 5` and **exclude `low_confidence_ev`** rows so thin/stale-FMV dists don't headline.

## Data caveats (so you don't mis-read sparse rows as bugs)
- **Dist attribution is INTRINSICALLY PARTIAL for AllDay (verified) — design the per-dist UI to degrade gracefully, don't wait for it to "fill".** `distId` exists ONLY in the `PackNFT.Mint` event (NOT on the `PackNFT.NFT` resource — proven on-chain; NOT queryable any other way), so `resolve-allday-pack-dist` must scan Mint events. The scan now covers the full 148.9M→156.45M mint era (ceiling bug fixed 2026-06-29), but AllDay launched 2022 — packs minted before the floor (≈Apr 2026), i.e. **old holdings opened recently, are infeasible to attribute** (mints hundreds of millions of blocks back). So `v_allday_pack_lifecycle` per-dist depletion + `v_allday_pack_realized_ev` populate only for *recently-minted-then-opened* packs and will stay partial by data nature. **The global aggregate (`v_allday_pack_lifecycle_global`), realized pull value, and edition provenance are complete and don't need dist** — lead the AllDay pack UI with those; treat per-dist depletion/reality-check as a bonus that shows where available (gate per-dist rows on `packs_opened>0` and the board on `n_opens>=5`, which you already do).
- **Realized-EV reality-check needs paid-dist ∩ opened overlap.** The first attributed opens were dist 180 = "Gift Pack" (no odds/pool/EV → correctly absent from the reality-check). It populates as *paid* dists get attributed.
- **Pull resolution ~99%** via on-chain open-block borrow (`resolve-allday-pull-editions` v3 + `rollup_allday_rip_pull_value()`); only opens older than Flow's execution-state window would miss (none currently).
- **Realized value rides on AllDay FMV**, which is thin (only ~15% HIGH/MED) — `low_confidence_ev` flags dists whose value rests on STALE FMV; surface that flag, don't hide it.

## Optional ops (DB, not frontend — only if wanted)
- If opened packs minted before block 148.9M need dist attribution, lower the floor in `resolve-allday-pack-dist` (param `floor`) + reset `allday_mint_scan_state.next_height`. Currently honest-NULL for pre-floor packs.
- Cadence already bumped: `rpc-allday-listing-ask-fmv` daily → `40 */6 * * *` (revert: `cron.alter_job(19, schedule => '40 9 * * *')`).

## Reference (Cowork session docs)
`handoff-2026-06-29-allday-realized-value-and-dist.md`, `-allday-fmv-cold-tail-diagnosis.md`, `-allday-pack-open-ingestion.md`. Gated read-only edge fns left for reuse: `resolve-allday-pull-editions`, `resolve-allday-pack-dist`, `find-allday-pack-open`, `probe-allday-pack-events`.
