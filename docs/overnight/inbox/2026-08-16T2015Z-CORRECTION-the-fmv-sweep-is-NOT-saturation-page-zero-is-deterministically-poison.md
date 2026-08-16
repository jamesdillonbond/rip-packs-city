> ⛔⛔ **SUPERSEDED — DO NOT ACT ON THE TITLE.** The "deterministic page-0 poison" claim in this file is **WRONG**: it was a **selection artifact**. `pipeline_runs` records only `fmv-recalc`'s fast-fail exits, so the 21/21 below is 21 members of a filtered subset, not a failure rate — the true rate is **~32% (20 of 62)**, read off the `fmv-recalc-heartbeat` sibling. **The load-invariance argument dies with it**, because the subset is selected *by* fast failure. Resolution: [2026-08-16T2030Z-RESOLVED-the-denominator-existed-fmv-recalc-heartbeat-and-I-had-it-at-1640Z.md](2026-08-16T2030Z-RESOLVED-the-denominator-existed-fmv-recalc-heartbeat-and-I-had-it-at-1640Z.md).
>
> **What survives, unchanged:** the cursor has not advanced since **06:48:06Z**; `fmv_sweep_wedge_hours` **13.40** vs breach 3 is correct and climbing; this is a **coverage** outage, not an FMV outage. Kept unedited below as the record of a wrong turn.

# ⛔ CORRECTION — the FMV sweep failure is **NOT saturation**. Page 0 fails deterministically, and it will not self-heal.

Cowork **cloud** session, 2026-08-16 20:15Z / 13:15 PT. **This corrects my own 16:40Z filing.**

> ⚠ **Scope line.** NO-PUSH is specific to **this cloud Cowork session**. Trevor's machine and Claude Code push normally. **Commit as usual.**

## What I got wrong

At 16:40Z I wrote: *"The sweep is a **casualty** of the saturation wave, not a defect."*

**I took that from the error string.** The route classifies its own failure as `sales_refetch_failed: 1 chunk fetch errors (saturation-class)` — and I read the route's self-label as a measurement. It is not one. **Distrust the instrument before the system**; I did the opposite.

## The measurement that refutes it

`fmv-recalc` since the wrap at 09:20Z, spanning **10.8 hours**:

| | |
|---|---|
| runs | **21** |
| `ok` | **0** |
| at `cursor_before='0'` | **21 of 21** |
| rows written | **0** |

Now put that beside platform saturation over the *same* window — which moved **more than tenfold**:

| time | platform fail % | fmv-recalc fail % |
|---|---:|---:|
| 09Z hour | 18.6 | **100** |
| 15Z hour | 14.9 | **100** |
| **17:20Z (30 m)** | **1.8** | **100** |
| 20:12Z (30 m) | 7.7 | **100** |

⚠ **A saturation-caused failure tracks saturation. This one did not move at all** — it stayed pinned at 100% straight through the quietest window of the day, the same trough in which the freshness-view migration was applied cleanly. **21 for 21 across a 10× swing in load is not a load problem.**

## The hypothesis that fits every observation

1. The sweep advanced normally at cursors **9500 → 10000 → 10500 → 11000 → 11500**, all `ok`, ~495 rows each.
2. At **06:48:06Z** it returned a 99-row partial page with `cursor_after = NULL` — the legitimate end-of-catalogue signal — and **wrapped to offset 0**.
3. **Every run since has been at offset 0, and every one has failed.** Each finds `rows_found: 500`, then dies in the sales refetch.

👉 **Page 0 of the new pass is deterministically poison.** The failure began at the wrap, not at a load threshold, and it is invariant to load. Something in the first 500 editions of that ordering kills the sales refetch, and it would do so at 3 a.m. on an idle instance.

**Falsifier — this is what makes it a claim and not a story:** the sweep will keep failing at offset 0 indefinitely, regardless of load, until either the page's content changes or the cursor is advanced past it. If it recovers on its own during a quiet period without anyone touching it, this hypothesis is dead and saturation was right after all.

**Next step is to name the poison, not to widen a budget:** run the sweep's own page query at `offset 0, limit 500`, then refetch sales for those edition ids in chunks and find which chunk throws. That isolates it to a row.

ⓘ Two distinct errors appear in the 21: the dominant `sales_refetch_failed`, plus **3** early `edition_page_fetch: Timed out acquiring connection from connection pool`. **Those three probably WERE saturation** — they cluster in the 13–15Z spike. The persistent one is not.

## Both arms are now correct and both are climbing

| metric | 16:09Z | 16:40Z | 19:25Z | **20:12Z** | breach |
|---|---:|---:|---:|---:|---:|
| `fmv_sweep_wedge_hours` | 9.39 | 9.82 | — | **13.40** | 3 |
| `fmv_sweep_stall_pct_24h` | — | 49.0 | 51.9 | **53.6** | 50 |

The stall arm **fired**, ~10 hours after the outage began — exactly the latency predicted for a 24 h trailing window whose lag scales with prior health. ⚠ The 16:40Z filing's *"1 point from firing"* was a **countdown, not a state**, and Trevor correctly refused to paste it forward once it expired.

**Severity is unchanged and still bounded:** this is a **coverage** outage, not an FMV outage. `refresh_wmc_fmv_changed` keeps writing (106,638 rows/24 h) so anything that trades is repriced; what stops is the systematic pass over editions that **don't** trade — the cold tail.

## ✅ Unrelated: the 20:07Z re-breach prediction landed

`trust_precompute_max_age_hours` = **13.08** vs breach 13 at 20:12:02Z → **BREACH**, exactly as predicted at 16:15Z. Back-solving, 13.08 h before 20:12:02Z is **07:07:14Z**; the predicted crossing was leg 326's pre-split write at **07:07:21Z** — within rounding of a 2-decimal hour.

⛔ **Do NOT revert the split.** Leg 326 `rpc_thp_leg_board_liveness` fires at **20:48Z** and the arm goes green for good at a ~5.7 h steady state.
