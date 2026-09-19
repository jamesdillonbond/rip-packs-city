# `edition_fmv_current` serves a value its own source row contradicts — and it is what eleven public boards read

*Cowork cloud, filed 2026-09-18 ~7:30 PM PT (09-19 02:30Z). **READ-ONLY apart from one table COMMENT.** No data patched, no board re-pointed — deliberately, and the reasons are below.*

## How this was found: an equivalence check that was supposed to be a formality

R50's residual work is "point the remaining boards at `edition_fmv_current` instead of a per-row `fmv_snapshots` LATERAL", the recipe that took `allday_scarcity_board` from 22,742 to 8,888 buffers on 2026-09-02.

The next board qualified on cost. `v_topshot_parallel_premiums` does **two** LATERAL probes per row into the partitioned snapshot table, and in 21 sweeps where the rest of the fleet was calm it still ran a **p50 of 6,437 ms** against a 9,100 ms budget — **p90 60,054 ms, worst 93,725 ms, i.e. over the 60 s prerender ceiling that can fail a production build.** One warm EXPLAIN: 55,490 buffers, of which **33,654 (61%) are the two LATERALs**.

Coverage checked out: **4,477 of 4,477** parallel editions and **9,539 of 9,539** base editions are present in `edition_fmv_current`. Then the value check failed.

## ⛔ The cache disagrees with the exact row it points at

```
edition 151:5629  (Angel Reese)
  newest fmv_snapshots row : computed_at 2026-09-18 06:45:00.19936Z
                             fmv_usd 4,949.45 · ask_proxy_fmv 8999
                             floor_price_usd 8999 · ASK_ONLY
                             algo_version  ultimate-v1_haircut
  edition_fmv_current      : computed_at 2026-09-18 06:45:00.19936Z   ← SAME STAMP
                             fmv_usd 8,999.00
```

Same edition, same `computed_at`, different value. **Every one of the top offenders is off by exactly 0.55×** — the cache is serving the **pre-haircut ask** as FMV. This is not the hourly refresh lag: the lag hypothesis predicts different `computed_at` values, and these are identical.

## The mechanism

`refresh_edition_fmv_current()` is the **only** writer (every routine body scanned for INSERT/UPDATE against the table), and its `DISTINCT ON (edition_id) ORDER BY computed_at DESC` logic is **correct**.

The defect is the incremental window:

```sql
v_cutoff := v_watermark - interval '2 hours';   -- v_watermark = max(computed_at) in the cache
...  WHERE s.computed_at > v_cutoff
```

FMV writes in this repo are **delete-then-insert** (CLAUDE.md). A later pass can replace a snapshot **while keeping its original `computed_at`**. Once the watermark has advanced more than 2 h past that stamp, the replacement never enters the window again and the cache holds the superseded value indefinitely. The `WHERE EXCLUDED.computed_at >= t.computed_at` guard cannot help — the row is never read at all.

⭐ This is the estate's own class, one level down: **a denormalised cache whose refresh keys on a column its writer does not bump.**

## 📏 Blast radius — Top Shot only, and bounded on purpose

Measured against the exact source row each cached row *names* (join on `edition_id` + `computed_at`, not a LATERAL — so this tests the cache's own pointer):

| | |
|---|---:|
| `edition_fmv_current` rows | 14,016 |
| pointer still resolves to a live source row | 13,489 |
| …of which `fmv_usd` **disagrees** | **26** |
| net overstatement on those | **+$46,060.16** |
| max single delta | **$4,049.55** |
| pointer resolves to **nothing** (row replaced) | 527 |
| …edition has no snapshot at all | **0** ✅ |
| …has a NEWER snapshot (cache behind) | 469 |
| …cache is AHEAD of newest source | 58 |
| …would change value on refresh | 136 (max Δ $254.85) |

⇒ **162 of 14,016 Top Shot editions (1.16%) publish a value their own source contradicts, and the skew is HIGH.**

⚠ **NOT measured: the other four collections.** The all-collections form statement-timed out at 120 s. **Do not quote a platform-wide number from this filing.**

## What was deliberately NOT done

1. ⛔ **The parallel-premiums swap is not shipped.** That board reads `fmv_snapshots` directly today — the accurate source. Swapping it would have made a public pricing board faster and wronger. R50's recipe is still right about cost and now carries a correctness precondition.
2. ⛔ **No data patch.** Aligning the 162 rows with one UPDATE clears today's symptom, leaves the mechanism intact, and makes the incidence unmeasurable — the "fix the guard without fixing its record" failure already on file here.
3. ⛔ **No refresh change.** Both candidates below alter what users are told a moment is worth.

## 👉 The fix, specified rather than attempted

- **(a) Periodic FULL reconcile.** `refresh_edition_fmv_current()` already has a full-rebuild branch, but its own comment says *"~1.23M rows, minutes when cold"* — it needs a cost measurement on this IO-bound instance and a quiet window before it goes on a schedule.
- **(b) An `updated_at`/version column on `fmv_snapshots`** that the incremental refresh keys on instead of `computed_at`. Structurally the right answer; a bigger change.

📏 **Falsifier for this filing:** re-run the pointer join. If `fmv_mismatch` is 0 and orphan pointers are ~0, the mechanism was something transient and this row should be closed, not acted on.

## Adjacent, recorded so it is not lost

`v_topshot_parallel_premiums` is genuinely the one board with a per-board cost problem: in 21 calm sweeps it went over budget 5 times at a calm p50 of 6,437 ms, while every other board's calm p50 is in the tens of milliseconds. The two boards behind it (`topshot_2025_rookie_cohort_stats`, `panini_sale_feed_status`) sit at calm p50 1,828 ms and 909 ms — **under** their budgets. Its cost fix is still owed; it just cannot be this one until the cache is trustworthy.
