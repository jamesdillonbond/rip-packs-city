> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# The edition-page family seq-scanned a 31 MB table twice per call — and a 40-minute diff over-ranked a daily job by 36×

**Filed 2026-08-31 23:20Z (16:20 PT) · cloud-only pass, NO PUSH · migration `20260831231308` applied to prod**

## What was wrong

`public.editions` is 27,341 rows in **3,921 pages / 31 MB**. Six public read RPCs were reading all of it,
once or twice, on **every edition- and moment-detail page view**:

- **`sub_names`** (`get_edition_recent_sales`, `get_moment_detail`) — a `DISTINCT ON (subedition_id)` Seq
  Scan + Sort over the whole table, *Rows Removed by Filter: 23,504*, **to produce 21 rows**.
- **the `ed` CTE** (`get_edition_detail`, `get_edition_fmv_history`, `get_edition_in_packs`,
  `get_edition_recent_sales`, `get_edition_sale_history`) — `collection_id = $1 AND (external_id = $2 OR
  id::text = $2)`. The second OR arm is a **cast of the primary key**; nothing indexed it, so the whole
  disjunction fell back to a Seq Scan despite the first arm having a unique index.

Both were found by reading the **generic** plan (a 4-parameter `PREPARE`, six executes) rather than the
body with literals, and the second was found by grepping `pg_proc.prosrc` for the **expression**, not the
file — the seventh instance of that rule.

## What shipped

Two indexes, `CONCURRENTLY`, as postgres. No function, view, ACL or grant touched.

```
idx_editions_subedition_name_lookup   48 kB   (subedition_id, subedition_name)
                                              WHERE subedition_id IS NOT NULL AND subedition_name IS NOT NULL
idx_editions_id_text               1,600 kB   (((id)::text))
```

Baseline re-taken **in the same state** (post-`VACUUM (ANALYZE)`, index dropped `CONCURRENTLY`,
re-measured, rebuilt), every reading warmed twice, all through the function:

| | before | after | |
|---|---:|---:|---|
| isolated `sub_names` cursor | 3,924 buf / 40.4 ms | **16** / 4.5 ms | 245× |
| isolated `ed` CTE | 3,003 buf | **7** | 429× |
| `get_edition_detail` | 2,976 / 13.3 ms | **30** / 4.1 ms | 99× |
| `get_edition_in_packs` | 2,994 / 10.1 ms | **48** / 0.9 ms | 62× |
| `get_edition_recent_sales` | 7,682 / 26.0 ms | **811** / 4.1 ms | 9.5× |
| `get_moment_detail` | 4,737 / 22.3 ms | **862** / 10.1 ms | 5.5× |

⚠ The `VACUUM` was load-bearing, not incidental: the very first index-only scan reported **Heap Fetches
1,282** against a stale visibility map and came in at 1,111 buffers. Post-vacuum it is 16.

⚠ `idx_editions_id_text` shows `idx_tup_read = 0` and that is **correct**. Route slugs are `external_id`s,
so the UUID arm never matches; the index's job is to make the disjunction *indexable*, which is what lets
the planner build a BitmapOr instead of surrendering to a Seq Scan. Judge it on `idx_scan`, never on
`idx_tup_read`.

## The bigger finding is about the instrument

`fmv_apply_thin_sale_haircut` ranked **#2 by buffers on the same diff — 7 calls, 2,730,915 buffers,
390,131 per call** — and carries the exact `DISTINCT ON (edition_id) … FROM fmv_snapshots` anti-pattern
another session fixed in `apply_fmv_thin_sales_guard` at 15:11Z today. It reads as a textbook
sibling-never-got-the-fix, and I spent the first forty minutes of the pass on it.

**It is not a lever.** Those 7 calls are **7 per day**. Across all 21 rows of
`audit_20260830_pgss_snap` its `calls` counter sits at 4,893 from 08-30 13:57Z, steps once to 4,900
between 21:06Z and 23:07Z on 08-30, and is *still* 4,900 at 22:20Z on 08-31. It is the once-daily
cron-job.org catch-all ("RPC Apply FMV Haircut", 15:35 PT = 22:35Z) that my window happened to straddle.

⭐ **The 08-30 route fix worked.** `20260830040739` + commit `eb54432` moved the inline `/api/fmv-recalc`
caller onto `fmv_apply_thin_sale_haircut_for_editions` (252 calls) and left the unscoped two-argument
function running once a day. **Do not re-open it.**

📏 **Rule for item 15: a 40-minute diff over-ranks a once-daily job by ~36×.** Before treating a diff row
as a lever, divide its `d_calls` by the window length and check it against the caller's cadence — the
snapshot table already holds the rows that answer that, and reading them costs one query.

## Left for later, deliberately

The honest fix for the `ed` CTE is in the five bodies: `id::text = p_route_slug` →
`(p_route_slug ~ '^[0-9a-f-]{36}$' AND id = p_route_slug::uuid)`, which needs no expression index at all
and would let `idx_editions_id_text` be dropped. Five `CREATE OR REPLACE`s of live public read paths is
not a same-pass change when an index buys the identical plan at zero semantic risk.

Also unexamined: `get_edition_market_bundle`, 138 calls / **8,243 buffers per call**, the highest per-call
figure of any continuous production reader in the window and the only one of the top four this pass did
not touch. That is the named next lever.

## Exit condition

PASS if the next pgss diff puts `get_edition_recent_sales` under **2,000 buffers/call** (measured 811) and
`get_moment_detail` under **2,000** (measured 862); they were 4,550 and 4,884. FAIL and revert
(`DROP INDEX CONCURRENTLY`, halves independent) if either stays above 4,000, or if `idx_scan` is 0 on
either index 24 h from now.
