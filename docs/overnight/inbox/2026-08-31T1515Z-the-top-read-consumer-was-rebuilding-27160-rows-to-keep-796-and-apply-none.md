> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# 2026-08-31T15:15Z — the top read consumer was rebuilding 27,160 rows to keep 796, and applying none of them

**Status: SHIPPED (`20260831151141`), plus one correction to a previously-filed number.**
Cloud-only firing, no desktop bridge, cannot push. Read at `origin/main` `399dee6` (08:09 PT).

## The finding

On the `pg_stat_statements` **diff** (baseline `audit_20260830_pgss_snap` @ 13:25:13.250845Z, current
15:02:50Z — a 1 h 38 m window, joined on `(userid, dbid, toplevel, queryid)`),
`apply_fmv_thin_sales_guard(p_mode)` was the **#1 real consumer**: 10 calls, 13,034,115 shared blocks,
**1,303,411 blocks/call**, 18,205 ms.

⚠ **The one row above it is a decoy and the next reader should not chase it.** `public.query_sql` shows
32.7 M blocks over 81 calls (404,211 blocks/call), but it is the **generic SQL passthrough** —
`app/api/fmv-recalc`, `app/api/admin/pipeline-health` and `lib/pack-dist/fetchers.ts` all call
`rpc("query_sql", …)`, so 81 unrelated statements collapse into one pgss row and its "per call" mean is an
average over queries with nothing in common. There is no single plan behind it to fix.

## Why it cost that much

The cursor was `WITH latest AS (SELECT DISTINCT ON (edition_id) … FROM fmv_snapshots ORDER BY edition_id,
computed_at DESC)` — a Merge Append over the **whole partitioned history, 1,353,022 rows / 710 MB** — which
then applied `WHERE fmv_usd > 200 AND confidence <> 'ASK_ONLY'` and **threw away 26,364 of the 27,160 rows
it had just materialised.** It kept 796.

⭐ **And the 796 lead nowhere.** Dry run at 15:06:47Z: `total_examined 796`, `skipped_already_capped 616`,
`thin_sales_count 0`, `stale_count 0`, `common_outlier_count 0`, **`total_caps_applied 0`**. The function
was spending 1.3 M buffers per call, ~72 calls a day, to apply zero caps.

## The fix and the proof

`editions CROSS JOIN LATERAL (SELECT … FROM fmv_snapshots WHERE edition_id = e.id ORDER BY computed_at DESC
LIMIT 1)` — 27,331 index probes instead of a 1.35 M-row pass. Nothing else in the body changed.

| | rows | buffers | ms |
|---|---:|---:|---:|
| baseline | 796 | 1,300,717 | 2,034 |
| candidate | 796 | **168,886** | **383** |
| baseline re-run **after** the candidate, same state | 796 | 1,300,773 | 1,939 |

Through-the-function control, same instrument, five minutes apart: **1,304,394 → 198,799 blocks**,
**1,824 → 758 ms** (and the "after" call also ran the security checks, so it over-states the function).

**Equivalence proven, not asserted:** both shapes side by side returned 796 rows with symmetric difference
**0 in both directions across all 26 output columns**; zero `fmv_snapshots` rows lack an `editions` row.

⛔ **`edition_fmv_current` was the obvious driver and is the wrong one here.** It holds exactly the same
27,160 edition_ids and is what `20260830165128` used for `get_market_summary` — but it lags by its refresh
watermark, and **70 of 27,160 rows carried a different `(fmv_usd, confidence)`** at 15:04Z. ⭐ **A
"latest per edition" cache is safe behind a COUNT and unsafe behind a PREDICATE**: 70 rows is enough to move
editions across a `> 200` boundary and silently change which editions the guard considers.

## The correction

The 08-31 entry for `get_acquisition_stats` (`20260831001448`) headlines **"3.2 s → 24 ms"**. The fix is
real — **3,175 blocks/call** against the ~16 k recorded pre-ship. But the **live per-call mean** is
**1,035.8 ms** (15:14Z diff, 10 calls) and was **1,646 ms** (09:35Z diff, 10 calls). 3,175 blocks cannot
produce a second of CPU, so the gap is service time, not work.

⭐ **The transferable, third instance of this shape this week: a single EXPLAIN measures one plan, on one
input, at one moment. The pgss row measures what users actually pay.** When they disagree by two orders of
magnitude, the pgss row is the one that describes the product. File both; quote the second.

## Open, not actioned

`get_pack_realized_ev_row`: **3,032 blocks/call, 1,313 ms/call** (11 calls, 13:25→15:14Z) against 283 ms at
09:35Z, with a live `[pack-detail] pack_realized_ev read exceeded 5000ms` cluster last seen 14:28Z. Same
cheap-in-work / slow-in-wall shape. Left for the next pass — one lever per pass.
