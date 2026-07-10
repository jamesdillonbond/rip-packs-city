# Handoff — NFL All Day pack EV: diagnosed, corrected (derived view), canonical fix + FMV lever (2026-06-29, Cowork)

Trevor: "We need to get NFL All Day Pack info dialed in." This session found *why* AllDay pack EV was garbage, built a corrected derived surface (live, security_invoker, never overwrites canonical), and verified it. What remains is one EV-pipeline change and one FMV-quality lever — both flagged below. All DB objects are live migrations; the route/pipeline items are the parts Cowork can't push.

## What was wrong (root cause, measured)

The canonical AllDay EV (`compute_pack_ev_from_pool`, called by `compute-allday-pack-ev`) takes a **flat top-10%-trimmed `avg(fmv) × slots`** over the pool. It **ignores `drop_weight` entirely** (and the pool writes `drop_weight: 1` for every edition anyway — see the edge fn's own comment: *"switching to tier-weighted when Dapper populates packOdds"*). Two pathologies follow:

1. **Rare-heavy inflation.** A 1-in-thousands Legendary is averaged in as if as likely as a common, so a $4 "Game Day" pack modeled at **$430**. (Houston Texans Game Day: modeled $429.97.)
2. **Per-edition FMV outliers.** A single mispriced "COMMON" at **$374.85** (circ 7,500) dominates any naive circulation-weighting (Jaguars 2024 Release blew up to $20 on a $2 pack before I made the value robust).

And underneath both: **AllDay FMV is thin** — of 6,191 editions, only ~15% are HIGH/MEDIUM confidence; **23% NO_DATA, 13% STALE, 36% LOW, 12% ASK_ONLY**. So even a perfectly-weighted EV rests on weak FMV.

## What I built live (Cowork — durable, verified)

**1. Captured the real odds.** `searchDistributions.packOdds` IS populated (e.g. LEGENDARY 36/24000, RARE 2400/24000, COMMON 21564/24000) — the pipeline fetched and threw it away. Extended edge fn `backfill-allday-pack-supply` (v2, gated `?key=`, verify_jwt off) to store `pack_odds` + `edition_ids` + `title` on `allday_pack_supply` (added those columns; `audit_20260629_allday_supply_add_odds`). Also fixed the prior early-break dedup bug (it stopped at the first duplicate-id page) — coverage went **1,360 → 3,075 dists, all with odds**. **512/521 EV-priced dists now have odds** (but only 170 carry *real* non-empty odds; the older catalog publishes `[]`).

**2. Corrected EV view (derived, never canonical).** `v_allday_pack_ev_corrected` (security_invoker, anon-SELECT; `audit_20260629_allday_pack_ev_corrected_tier_median`). Per pack:
- Value each **tier by its MEDIAN FMV** of priced pool editions (robust to the $374 outlier class).
- Weight tiers by **pull probability**: published `packOdds` where present (`ev_method='published_odds'`, 165 dists), else **circulation share** (`circulation_weighted`; P(pull) ≈ mint count — validated below).
- `best_gross_ev` / `best_net_ev` / `best_value_ratio`, plus `modeled_gross_ev` and `corrected_to_modeled_ratio` for comparison.
- Reliability: `stale_value_share_pct`, `fmv_coverage_pct`, `low_confidence_ev` (true when ≥50% of value is STALE/NO_DATA or coverage <70%).

**3. Surfaced it.** `v_allday_pack_info` now also exposes `corrected_gross_ev`, `corrected_net_ev`, `corrected_value_ratio`, `ev_method`, `has_published_odds`, `stale_value_share_pct`, `low_confidence_ev` (`audit_20260629_allday_pack_info_add_corrected_ev`).

### Validation (why trust the corrected number)
- On the 165 dists with **both** published odds and circulation weighting, the two agree closely on standard packs (Enshrinement 28 vs 33, Rewind Playmakers $4.8 vs $5.8 — odds method chosen) and diverge *correctly* on Premium packs (odds higher, because premium packs boost rare odds above circulation share — so published odds wins there).
- Median-robust valuation killed the over-correction tail (packs where corrected ≫ modeled) from many down to **2**.
- Result: 507 EV-priced packs corrected; **median corrected/modeled = 0.56** (the canonical model systematically over-states ~1.8×); **414/507 (82%) flagged `low_confidence_ev`** — honest, because AllDay FMV is thin.
- Spot checks: Houston Game Day $430→**$5.81**; Detroit $354→**$9.68**; Immaculate Reception Premium $2666→**$974** (odds, but 100% stale → low-confidence); Jaguars 2024 Release $20-naive→**$0.44** (outlier ignored).

Security: `check_public_security_invariants()` clean; both views `security_invoker=on` + SELECT-only.

## Item A — Canonical EV fix (EV-pipeline change → review-gated, your call)

Make the canonical AllDay EV odds/circulation-aware + median-robust, instead of flat-trimmed-mean. Two ways:

- **Lighter:** in `compute-allday-pack-ev` (edge fn, Phase 2 of the pool write), set `drop_weight` per edition from `packOdds` (tier prob ÷ tier edition count) where odds exist, else from `circulation_count` — then teach `compute_pack_ev_from_pool` to use `SUM(fmv·drop_weight)/SUM(drop_weight)` (it currently ignores drop_weight) with a **per-tier median** instead of trimmed mean. The view `v_allday_pack_ev_corrected` is the reference implementation of the target math.
- **Cleaner:** leave the canonical pipeline as-is and have consumers (packs page, dashboard, any AllDay pack-EV surface) read `v_allday_pack_info.corrected_gross_ev` / `corrected_net_ev` with the `low_confidence_ev` caveat shown — exactly the Top-Shot `v_topshot_pack_ev_calibrated` adoption pattern. **Recommended** (no pricing-logic mutation; reality-check stays non-circular).

Either way: **show `low_confidence_ev` in the UI** — most AllDay pack EVs ride on STALE FMV and should be labeled, not trusted blindly.

## Item B — The real lever: AllDay FMV freshness

The corrected EV is now structurally honest, but it can't be *good* until AllDay FMV is better than 15% HIGH/MEDIUM. AllDay has **no rips** (0 `pack_rips`), so unlike Top Shot there is **no realized-pull reality-check** to calibrate against. Levers, in order of ROI: (1) widen ASK-derived FMV for the 742 ASK_ONLY + cold-tail editions (the proven `ask×0.90` path from Top Shot); (2) refresh the 804 STALE via the AllDay sales-history backfill already running; (3) the Phase-2 worker (AllDay pack-open ingestion) would unlock realized-pull calibration — see `docs/handoff-2026-06-28-allday-pack-lifecycle.md`.

## Guardrails / revert
- Direct to `main`, no PRs. New views must stay `security_invoker` + anon-SELECT.
- The corrected view is inert until a consumer reads it; the canonical EV is untouched.
- **Revert:** `DROP VIEW public.v_allday_pack_ev_corrected;` then `CREATE OR REPLACE VIEW public.v_allday_pack_info` without the appended `c.*` columns + its join; columns `pack_odds/edition_ids/title` on `allday_pack_supply` are additive (leave or drop). Edge fn v2 is backward-compatible (only adds captured fields).
- Re-run the odds/supply capture on demand: `SELECT net.http_get('https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/backfill-allday-pack-supply?key=rpc_pls_8x2f9k3m_allday', timeout_milliseconds:=90000);` (no cron — odds are static and AllDay ended primary sales).
