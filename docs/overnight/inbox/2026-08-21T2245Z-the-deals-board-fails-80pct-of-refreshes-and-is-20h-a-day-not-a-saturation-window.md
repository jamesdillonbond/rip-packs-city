# The flagship `deals` board fails ~80% of refreshes, is up to 15.1h stale, and the failure is ~20h/day — not the 05–08:30Z saturation window

**Filed 2026-08-21 ~15:45 PT (22:45Z), Claude Code interactive. MEASURED, with controls. NOT fixed —
the fix is a board/FMV query rewrite, which is off-limits for autonomous shipping and is the same class
as the two DB fixes CLAUDE.md already records as "blocked on a DECISION not a diagnosis".**

Follows the 17:30Z filing, which correctly established that Vercel's route attribution is smeared and then
closed with *"the underlying timeouts are real … nothing here says the boards are healthy."* This is what
those timeouts actually cost.

---

## ⚠ 1. The smearing hid the two boards that matter, which is that filing's own "inverse risk", realised

The 17:30Z filing is about `[panini-squeeze]` and eight `[candy-mlb]` groups — the errors loud enough to
surface in `get_runtime_errors`. **Panini and Candy MLB are both UNPUBLISHED collections**
(`is_active=false`). Meanwhile, per-board outcomes from `pipeline_runs.extra.boards`, 509 ticks / 48h:

| board | fail % | live? |
|---|---:|---|
| panini-squeeze | 79.0% | unpublished |
| **deals** | **78.2%** | **live — flagship** |
| **first-mint** | **63.7%** | **live** |
| candy-mlb | 17.7% | unpublished |
| rookies | 12.0% | live |

**`deals` and `first-mint` do not appear anywhere in the 17:30Z filing.** They fail at panini's rate and
they are the published product. The instrument surfaced the loudest error STRING, not the worst-affected
board — exactly the inverse risk that filing warned about ("a genuine per-route failure is diluted into
the same long tail").

## 2. It is getting worse, measured as a series rather than a snapshot

`deals` fail %, by PT day (`pipeline_runs` retains ~73h, so 08-18 is a partial day at the retention edge
and is discounted):

| day (PT) | deals | first-mint | panini |
|---|---:|---:|---:|
| 08-19 | 67.7% | 55.0% | 71.2% |
| 08-20 | 80.4% | 66.3% | 80.4% |
| 08-21 | 80.1% | 62.7% | 80.7% |

Against the figure already recorded in `app/api/cron/refresh-insights-cache/route.ts` on **2026-08-15:
`deals` failed 59.5% of ticks**. So 59.5 → 67.7 → 80.4 → 80.1: a rise, then a plateau near 80%.
All three boards move together, which points at a shared cause rather than three query regressions.

## 3. ⚠ It is NOT the documented 05–08:30Z saturation window — it is ~20 hours a day

`deals` fail % by UTC hour, 72h:

| UTC hour | 23 | 00 | 22 | 21 | 20 | 01–19 |
|---|---:|---:|---:|---:|---:|---:|
| fail % | **0** | 9 | 6 | 15 | 40 | **71–100** |

The board succeeds in a **~4-hour window, 20:00–00:00Z (~1–5pm PT)**, and fails 71–100% of the time
across the other twenty hours. ⚠ **"Saturation-driven, self-heals when load lifts" no longer describes
this** — that framing is built around the 05–08:30Z spell recorded elsewhere in the ledger, and the
failure band is now four times wider than the healthy one. The healthy window is early-afternoon Pacific;
the board is stale through the US evening, when collectors actually browse.

## 4. What users get: up to 15.1 hours stale, but honestly labelled

From `extra.stale_boards`, 48h (ceiling is 2h):

| board | stale ticks | worst | average |
|---|---:|---:|---:|
| deals | 219 | **906 min (15.1 h)** | 415 min (6.9 h) |
| panini-squeeze | 219 | 905 min | 447 min |
| first-mint | 39 | 336 min | 230 min |

⚠ **This is NOT a "failed read renders as an answer" defect, and I checked before assuming it was.**
`readBoardOrLive` returns `source: "stale-cache"`, `withCacheMeta` stamps the snapshot's real
`fetched_at`, and `DealsBoardClient` renders `Updated <FreshnessStamp iso={fetchedAt} />`. The age is
disclosed truthfully.

**The judgement call, flagged not changed:** `degradedFromSource` returns a notice only for
`source === "live-degraded"`, so a 15-hour-old snapshot renders with **no degraded banner** — just a
relative timestamp. For a *deal-finding* board that is arguably too quiet (a 15h-old "below FMV" list is
mostly deals that are gone), but it is a product decision, not a defect, and the ladder was deliberately
built to treat `stale-cache` as non-regressive.

## 5. Cost, and ⚠ my own first hypothesis REFUTED by the plan

`cross_collection_deals_board` is a **view** (3,315-byte definition). `pg_stat_statements`:
**928 calls · mean 12,868 ms · 9,295,589 shared blocks read** ≈ **10,017 blocks (~78 MB) per call.**
The mean alone exceeds the statement timeout, so ~80% failure is arithmetic, not flakiness.

⚠ **I expected the AllDay leg's `JOIN LATERAL (SELECT … FROM fmv_snapshots … ORDER BY computed_at DESC
LIMIT 1)` to be the pathology** — it is the same shape CLAUDE.md records for
`compute_pack_ev_per_edition_weighted` (18,766 vs 1,046,192 buffers). **`EXPLAIN` refutes that.** Both
lateral legs are index-backed and partition-pruned
(`fmv_snapshots_2026_collection_id_edition_id_computed_at_idx`, "Subplans Removed: 1") at
**cost ≈ 1.8 each**. They are fine. Filing the inference without the plan would have sent the next person
at the wrong leg.

What the plan actually shows (total estimated 22,509):
- **TopShot leg ≈ 12,300** — driven by `Index Scan using idx_editions_collection on editions`
  **rows=19,838**, one lateral per row.
- **AllDay leg ≈ 9,400** — a `Sort → Unique` (DISTINCT ON) over a `cached_listings_v2` bitmap scan,
  **31,534 rows → 8,988** after filter.
- Pinnacle leg ≈ 739 (seq scan, 1 row out).

**The driver is that the outer `ORDER BY discount_pct DESC LIMIT 120` cannot push down** — all three legs
materialise ~1,396 candidate rows from ~19.8k editions and ~9k listings on **every** call. That is
CLAUDE.md's "a `LIMIT` bounds a query's OUTPUT, not its COST" rule, on the flagship public board.

## 6. Levers, none pulled

1. **Materialise it.** The board is already served from `public_board_snapshots`; the expensive view is
   re-run every 5 min by the cron. A matview refreshed on the same cadence would pay the cost once per
   refresh instead of per call, and would keep failing refreshes from starving the snapshot.
2. **Narrow the TopShot leg** — 19,838 editions scanned to yield ~1,308 rows. A pre-filter on the
   discount predicate before the lateral would cut the row count the lateral runs against.
3. **Lower the cadence.** At 80% failure the cron is mostly buying retries; every 15 min would cost a
   third of the IO for a board that is already 6.9h stale on average.
4. **Do nothing and widen the ceiling** — honest only if someone decides 15h-old deals are acceptable.
   ⚠ Do NOT simply raise `BOARD_SNAPSHOT_STALE_CEILING_MS` to silence the `STALE` lines; that converts a
   measured degradation into a quiet one.

⚠ **Not auto-shipped:** board/FMV query logic is on CLAUDE.md's off-limits list, and this is the same
class as the two measured-but-unshipped DB fixes already awaiting Trevor's decision. The diagnosis is
done; the decision is not mine.
