# `/api/collection-stats` runs the SAME 19,942-probe FMV scan **twice** per request — and the number it recomputes is already precomputed

**Filed 2026-09-01 ~22:4x PT (2026-09-02 ~05:45Z), Claude Code cloud session.**

> ✅ **SHIPPED 2026-09-01 ~22:5x PT** — migration
> `20260902054902_audit_20260902_collection_stats_folds_the_high_medium_pass_into_the_scan_it_already_makes`
> plus `app/api/collection-stats/route.ts` and the overview KPI. The fold went in exactly as described
> here, in BOTH branches (the Pinnacle render-grain one too), and equivalence was proved for all five
> collections in a single statement. R6 annotated; **R6 is NOT closed** — its owed saturation measurement
> is untouched. ⛔ The "tempting alternative" (reading `rpc_trust_health_precompute`) was NOT taken, for
> the reason given below. 🚨 **One thing this filing did not see:** the KPI fell back from
> `fmv_high_medium_pct` to `fmv_pct` when the former was null — a different, much larger metric (Golazos
> 87.3% vs a true 0.3%). Fixed in the same commit.

**Nothing shipped AT FILING TIME** (it has since shipped — see the banner above), **and the reason is stated rather than implied:** the fix patches a LIVE PUBLIC
function, and the safe way to do it is a technique this repo already owns (below). Filing it with the
full measurement so the next session can apply it with a diff in front of them.

Touches register **R6** (`get_collection_stats` times out on public collection landings) and **R52**
(the deferred latest-FMV-per-edition precompute). ⛔ **It does not overturn R52** — the win below needs
no new object at all.

## The measurement (2026-09-02 ~05:2xZ, OUTSIDE the saturation band — this is the quiet-hours floor)

`EXPLAIN (ANALYZE, BUFFERS)` on `get_collection_stats(slug)`, one call each:

| slug | buffers (hit + read) | ms |
|---|---:|---:|
| `nba_top_shot` | 244,916 (223,513 + **21,403**) cold · 244,754 (243,380 + 1,374) warm | 3,863 · **1,257 warm** |
| `nfl_all_day` | 82,816 (70,269 + **12,547**) | **3,265** |
| `disney_pinnacle` | 31,739 (29,168 + 2,571) | 830 |
| `ufc_strike` | 7,435 (7,271 + 164) | 113 |
| `laliga_golazos` | 6,954 (6,666 + 288) | 153 |

⭐ **30× separation, and it tracks EDITION COUNT** — consistent with a per-edition scan inside the
function. ⚠ **Top Shot's WARM call still touches 244,754 buffers**; only the disk reads fall. **This is
not a cache-warming problem** and cannot be waited out.

## The duplicate, which is the actionable part

`get_collection_stats` computes FMV coverage with one lateral probe **per edition**:

```sql
FROM editions e
CROSS JOIN LATERAL (
  SELECT fs.confidence FROM fmv_snapshots fs
  WHERE fs.collection_id = v_collection_id AND fs.edition_id = e.id
  ORDER BY fs.computed_at DESC LIMIT 1
) latest
WHERE e.collection_id = v_collection_id;          -- COUNT(*) FILTER (confidence <> 'NO_DATA')
```

`app/api/collection-stats/route.ts` → `computeHighMediumPct()` then runs **the byte-equivalent scan a
second time in the same request**, through `query_sql`, for a different FILTER
(`confidence IN ('HIGH','MEDIUM')`). They are in a `Promise.all`, so wall-clock hides it — **but the
DB load is the sum, and this instance is IO-bound (R46).**

**Second pass, measured on its own:** **116,945 buffers (7,884 read), 2,875 ms**, 19,942 lateral loops.

ⓘ Also visible in that plan: each probe hits **three partitions** — `fmv_snapshots_2027` returns 0 rows
on all 19,942 loops for **39,884 buffers**, ~34% of the leg. That is ~2 buffers per probe per partition,
the floor for an empty btree descent. ⛔ **Do not "fix" it with a `computed_at` lower bound** — an
edition whose newest snapshot predates the bound would silently drop out of the covered count.
👉 The transferable bit: **the tax of a partitioned lateral scales with PARTITION COUNT**, so adding a
2028 partition adds another ~40k buffers to this call for nothing.

## The fix, and why it is safe

**Fold the two aggregates into ONE pass.** The function already does the scan; adding
`COUNT(*) FILTER (WHERE latest.confidence IN ('HIGH','MEDIUM'))` to the *same* SELECT costs
approximately nothing, and the route then drops `computeHighMediumPct` entirely for the non-Pinnacle
path. **Same numbers, same freshness, ~117k buffers and ~2.9 s off every uncached request.** No new
object, no decision to reopen.

⭐ **And it does not need retyping the 12.5 KB function.** `20260815083710_audit_20260815_collection_stats_prune_future_fmv_partitions.sql`
already establishes the technique in this repo: read `pg_get_functiondef`, assert the pattern occurs
EXACTLY N times, refuse if already patched, `EXECUTE replace(...)`. Reuse it verbatim — anchor the
replacement on `INTO v_fmv_covered, v_fmv_pct` followed by `FROM editions e` (the Pinnacle branch's
`INTO` list is longer, so a bare prefix match would hit both — that is the trap).

## ⛔ The tempting alternative, and why I did NOT take it

`rpc_trust_health_precompute` **already publishes this metric per collection** —
`topshot_fmv_high_med_share_pct` = **39.9**, `allday` 25.4, `pinnacle` 45.0, `golazos` 0.3, `ufc` 0.0 —
refreshed roughly 3-hourly. **And it is the same instrument, verified:** the route's live number for
Top Shot right now is **39.8%** (7,927 of 19,942) against the precompute's **39.9%**, the 0.1 pt being
the precompute's ~3.5 h age. *(This is NOT R41's 49.7-vs-34.2 disagreement; that was a different pair.)*

Reading the precompute would take the second pass to **one row**. ⛔ **It is still a product decision,
not a free win:** it trades a live figure for one up to ~3 h stale **on a user-facing accuracy claim**,
and the precompute carries only the percentage — the route also returns `fmv_high_medium_count`, which
would have to be dropped or fabricated. **Fold first; swap only if someone decides 3-hour staleness is
acceptable there.**

## What this says about R6 and R52

- **R6's exit condition wants saturation-relative numbers.** These are the QUIET-BAND floor, and even
  quiet, All Day is **3.3 s** and Top Shot **1.26 s warm**. Under the documented 3–5× degradation the
  All Day branch alone clears any sane page budget — so R6 does not need a saturation window to be
  believed; it needs the fold.
- **R52 (build a precomputed latest-FMV-per-edition) stays deferred and is untouched by this.** The
  fold halves the cost without it. Re-open R52 on its own evidence, not on this.
