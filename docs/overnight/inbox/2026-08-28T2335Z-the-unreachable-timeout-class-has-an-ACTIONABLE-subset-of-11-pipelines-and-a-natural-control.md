# The ">120 s declared timeout" class has an ACTIONABLE subset — 11 pipelines, 116 opaque errors in 7 days — and `get_lock_check_batch` is a natural control that proves the mechanism

**2026-08-28 23:35Z · Claude Code**

CLAUDE.md already records the class: *"the Supabase GATEWAY hard-caps the PostgREST path at ~120 s
(`504 upstream request timeout`), so 48 declarations >120 s are unreachable on BOTH paths"*, with
`⛔ 122 of 195 exceed 30 s: load-bearing, do NOT strip as no-ops.` **What has never been enumerated is
which of them are ACTUALLY costing us an unattributable error right now.** That subset is small and
named.

⚠ **Re-derived, and the recorded count has MOVED: 45 functions in `public` declare >120 s today, not 48.**
Dated sample, 2026-08-28 — re-measure before quoting either number.

## The actionable subset — `upstream request timeout` by pipeline, 7 days

| pipeline | n | the error names |
|---|---:|---|
| `allday-unmapped-resolver` | **29** | `resolve:upstream request timeout` |
| `compute-allday-pack-ev` | **26** | `get_fmv_for_editions` |
| `populate-pinnacle-wmc-fmv` | **19** | (bare) |
| `run-insider-detectors` | **17** | `nba_top_shot:` |
| `allday-unmapped-resolver-tail` | 10 | `resolve:` |
| `lock-check-batch` | 5 | `get_lock_check_batch` |
| `drain-conflated-subeditions` | 4 | (bare) — R55's subject |
| `apply-fmv-haircut` · `topshot-misattrib-drain` | 2 each | R54's subject / `rekey:` |
| `compute-topshot-pack-ev` · `sales-counterparty-backfill` | 1 each | `get_fmv_for_editions` / `apply failed:` |

**116 occurrences across 11 pipelines.** Two named functions corroborate the mechanism directly:

| function | declared | reachable? |
|---|---|---|
| `get_fmv_for_editions` | `statement_timeout=300s` | ⛔ no — gateway kills at ~120 s |
| `populate_pinnacle_wmc_fmv` | `statement_timeout=300s` | ⛔ no |
| `get_lock_check_batch` | `statement_timeout=120s` | ⚠ **exactly at the boundary** |

## 🚨 The natural control, and it is unusually clean

`lock-check-batch` declares **120 s — precisely where the two bounds race** — and one run recorded BOTH
outcomes in a single error string:

> `get_lock_check_batch: nba_top_shot: canceling statement due to statement timeout | disney_pinnacle: upstream request timeout`

⭐ **Same function, same run, same declared timeout: one leg was cancelled by POSTGRES (attributable,
SQLSTATE 57014, greppable) and the other by the GATEWAY (opaque, no SQLSTATE, tells an operator
nothing).** That is the mechanism demonstrated rather than argued, and it is why the declaration value
matters even though it changes no work: **it decides who reports the failure.**

## What this is and is NOT

- ✅ **It is a DIAGNOSTIC defect, not a throughput one.** Lowering a declaration to ~110 s does not make
  anything faster and must not be sold as a fix for the timeout itself — it converts an unattributable
  gateway kill into a Postgres cancellation that names the statement. Precedent already set the same
  night: **R55 lowered four conflated-drain steps 
  to 110 s "to beat the ~120 s gateway"** (`20260828231031`).
- ⛔ **NOT SHIPPED, and the reason is coordination, not doubt.** A concurrent session is actively working
  this exact pattern (R55, R56) and shipped into it during this pass. Two sessions editing the same
  function-timeout class in the same hour is how the duplicate-migration collision earlier tonight
  happened. **Whoever picks this up should take the whole list at once, not one function at a time.**
- ⛔ **NOT established: that 110 s is right for these five.** `get_fmv_for_editions` is called by at
  least two pack-EV pipelines, so its declaration is shared — **name every caller before changing it**
  (CLAUDE.md's six-source rule, plus cron-job.org and Task Scheduler).
- ⛔ **NOT established: whether the underlying work fits in 110 s at all.** If it does not, lowering the
  declaration converts an opaque failure into an honest one and **the failure count does not drop** —
  which is the correct outcome, but a reader expecting a green board will misread it. Say so up front.

**Falsifier for the whole idea:** if a pipeline's declaration is lowered to 110 s and its errors still
read `upstream request timeout` rather than `canceling statement due to statement timeout`, then the
call is not taking the PostgREST path the way this filing assumes, and the model is wrong.
