# FMV confidence decomposition — 2026-05-28

Supplemental to `docs/audits/cowork-platform-pass-2026-05-28.md`. Produced during the 2026-05-28 Cowork pass after the platform health audit shipped.

## Headline findings

1. **The HIGH bucket is not regressing — it's been de-inflated.** Daily HIGH counts: May 22 = 465, May 23 = 553, **May 24 = 704 (peak), May 25 = 599, May 26 = 596, May 27 = 419, May 28 = 423.** The raw 704 → 423 drop (-40%) looks alarming until you decompose by algo: **203 of the lost HIGH editions were on `sales_wap_v1`** (the rogue inflated-AVG writer that was retired and dropped during the 2026-05-24/25 sessions). Those HIGH ratings were not legitimate. The honest baseline post-clobber-purge is ~501 HIGH; current 423 is 84% of that.
2. **The remaining ~78-edition gap (501 → 423) is the 2026-05-26 TS UUID-merge collapsing snapshot history.** 97 editions went HIGH → MEDIUM and 38 went HIGH → LOW on the same `1.7.0` algo — same algo, changed sale population for the canonical (the canonical now has merged sales from its UUID dupes, the serial-residual dispersion is different). This is a real but small data-fidelity cost of the merge, not a bug.
3. **Pinnacle is the FMV quality leader by a wide margin.** 229/427 HIGH (53.6%), 355/427 HIGH+MEDIUM (83.1%). The `pinnacle-1.0.0` algo + direct-chain listings reaches a confidence rate that the multi-collection `1.7.0` algo doesn't. The differentiator is universe size (427 editions vs 9,275 TS) + direct-chain ASK feed + active per-edition trading.
4. **The bottleneck for HIGH growth is algo coverage, not the HIGH gate.** Sample-count for HIGH editions is healthy (median 21 sales in 90d). The gate isn't over-tight. The real shortfall is that **3,784 AllDay editions are stuck on `allday-gql-v1`** (marketplace-GQL-derived pricing, not WAP-derived) — they've never been reprocessed by `fmv-recalc` 1.7.0. The sweep is moving (2,362 AllDay writes/24h on 1.7.0) but it'll take ~3-4 days more to fully cover AllDay.
5. **2,759 LOW editions have zero 90-day sales** (1,929 AllDay + 830 TS). They should be STALE, not LOW. `drain-fmv-cold-tail` only re-evaluates editions whose last snapshot is older than 7 days, and `fmv-recalc` keeps writing them LOW. The LOW→STALE downgrade logic is missing from `fmv-recalc`.
6. **NO_DATA cohort is overwhelmingly structurally-unpriceable.** 8,550 NO_DATA editions total: 7,066 TS + 526 AllDay + 536 Golazos + 422 UFC. **7,634 of 8,550 (89.3%) have NEVER sold in our entire sales history.** Genuinely unpriceable from sales data alone. **382 TS NO_DATA editions ARE catchable** (sold in last 180 days but no FMV snapshot) — the only realistic NO_DATA recovery target.

## Confidence breakdown by collection (latest snapshot per edition)

| collection | HIGH | MED | LOW | ASK_ONLY | SALES_ONLY | STALE | NO_DATA | total | HIGH+MED % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| nba_top_shot | 366 | 727 | 5,795 | 507 | 403 | 1,084 | 7,066 | 15,948 | 6.9% |
| nfl_all_day | 56 | 173 | 4,839 | 24 | 0 | 573 | 526 | 6,191 | 3.7% |
| ufc_strike | 0 | 0 | 20 | 3 | 0 | 1 | 422 | 446 | 0% |
| laliga_golazos | 1 | 0 | 2 | 25 | 0 | 17 | 536 | 581 | 0.2% |
| **disney_pinnacle*** | **229** | **126** | 47 | 0 | 0 | 0 | 25 | 427 | **83.1%** |

\* Pinnacle has its own `pinnacle_fmv_snapshots` table, not the main `fmv_snapshots`.

## Decomposition of the May 22 → May 28 HIGH-count trajectory

Daily HIGH editions (count of editions whose latest snapshot as of end-of-day was `HIGH`):

| day | HIGH | delta |
|---|---:|---:|
| 2026-05-22 | 465 | — |
| 2026-05-23 | 553 | +88 |
| 2026-05-24 | 704 | +151 (`sales_wap_v1` inflation pre-retirement) |
| 2026-05-25 | 599 | -105 (clobber-purge round 1) |
| 2026-05-26 | 596 | -3 (steady) |
| 2026-05-27 | 419 | -177 (TS UUID merge fallout — see breakdown below) |
| 2026-05-28 | 423 | +4 (sweep starting to recover) |

### Breakdown of the May 24 → May 28 HIGH losses by algo flip (top 10)

| was algo | now algo | was → now | editions |
|---|---|---|---:|
| `sales_wap_v1` | `allday-gql-v1` | HIGH → LOW | 154 |
| `1.7.0` | `1.7.0` | HIGH → MEDIUM | 97 |
| `1.7.0` | `1.7.0` | HIGH → LOW | 38 |
| `sales_wap_v1` | `1.7.0_haircut` | HIGH → LOW | 16 |
| `sales_wap_v1` | `cold-tail-1.0` | HIGH → STALE | 13 |
| `sales_wap_v1` | `allday-gql-v1_haircut` | HIGH → LOW | 11 |
| `1.7.0` | `cold-tail-1.0` | HIGH → NO_DATA | 7 |
| `1.7.0` | `1.7.0_haircut` | HIGH → LOW | 6 |
| `sales_wap_v1` | `1.7.0` | HIGH → LOW | 6 |
| `1.7.0` | `1.5.0` | HIGH → MEDIUM | 5 |

Reading this:
- All `sales_wap_v1` → `*` rows are **honest de-inflation** (the algo was rogue; its HIGH ratings were not legitimate). Total: 203 editions.
- All `1.7.0` → `1.7.0` rows are **same-algo recompute** (97 + 38 + 6 = 141 editions). Most likely cause: the 2026-05-26 TS UUID-merge changed the sale population for those canonical editions (their UUID-dupes' sales are now joined in), and the serial-residual dispersion crossed the HIGH gate threshold.
- 7 editions `1.7.0` → `cold-tail-1.0` HIGH → NO_DATA are likely the merge fallout combined with `drain-fmv-cold-tail` running on the canonical after its dupe snapshots got merged in.

## What can be done about it (not shipped — handoff candidates)

Three concrete levers, ordered by leverage:

1. **Accelerate fmv-recalc AllDay coverage.** Today AllDay gets 2,362 1.7.0 writes/24h; full AllDay population (6,191 editions) takes ~3 days at that rate. If `fmv-recalc` either bumps AllDay's slice of the cron OR runs a dedicated AllDay sweep, the 3,784 LOW-on-`allday-gql-v1` editions can be re-evaluated faster. Expected outcome based on the 1.7.0 confidence distribution on TS (366 HIGH / 727 MEDIUM / 5,795 LOW = HIGH+MED 16%): if the same ratio applies to AllDay's 4,839 LOW pool, ~770 of those would promote to MEDIUM or HIGH after re-eval. **Code-side change.**
2. **Add LOW→STALE downgrade to `fmv-recalc` for zero-90d-sales editions.** Today `fmv-recalc` writes LOW for an edition with any historical sales meeting the basic gate. An edition that sold 200 days ago shouldn't be LOW — it should be STALE. Concrete predicate: if `days_since_last_sale > 60` AND `sales_count_90d = 0`, write STALE instead of LOW. This honest-up the 2,759 affected editions. **Code-side change in `lib/fmv-confidence.ts` and/or `app/api/fmv-recalc/route.ts`.**
3. **Investigate the 382 catchable TS NO_DATA editions.** They have sales in the last 180 days but no FMV snapshot. Either `fmv-recalc` is skipping them (cursor / pagination gap) or they're failing the basic gate for a reason worth understanding. **Investigation, not a ship.**

## What's NOT actionable

- **Cohort-based pricing for the 7,634 never-sold-lifetime NO_DATA editions.** Per the 2026-05-23 audit, set+tier cohorts are too dispersed and player+tier cohorts have no coverage. The cohort approach was modelled and rejected. These are structurally unpriceable from sales data alone. The only path to pricing them would be a direct listings feed across all 5 collections — Pinnacle has one (which is why Pinnacle hits 53.6% HIGH); TS has `topshot-fmv-populate` reading `searchMarketplaceEditions` for the ~150-220 listed editions (memory `topshot-marketplace-fmv-feed`), which can't close the ~7k never-sold tail.

## Method notes (for reproducibility)

- "latest snapshot per edition" everywhere uses `DISTINCT ON (edition_id) ORDER BY edition_id, computed_at DESC`.
- "HIGH on day X" uses `WHERE computed_at <= '<day X>'::timestamptz + INTERVAL '1 day'` filter inside the same DISTINCT ON, then `WHERE confidence='HIGH'`.
- The 2,362 AllDay 1.7.0 writes/24h figure comes from `SELECT COUNT(*) FROM fmv_snapshots WHERE algo_version LIKE '1.7.%' AND collection_id = (AllDay UUID) AND computed_at >= NOW() - INTERVAL '24 hours'`.
