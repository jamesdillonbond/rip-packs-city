> ⚠ **PARTLY SUPERSEDED.** The headline measurement (`pipeline_runs` saw **1 of 6** invocations) is **correct and stands**. The closing generalisation — *"nothing inside the DB can reveal that"* — is **FALSE**: the denominator was inside the DB the whole time, under the separate pipeline name **`fmv-recalc-heartbeat`**. The honest claim is *"`pipeline_runs` filtered to one pipeline name is a sample,"* not *"the DB is blind."* Resolution: [2026-08-16T2030Z-RESOLVED-the-denominator-existed-fmv-recalc-heartbeat-and-I-had-it-at-1640Z.md](2026-08-16T2030Z-RESOLVED-the-denominator-existed-fmv-recalc-heartbeat-and-I-had-it-at-1640Z.md).
>
> ⛔ Recommendation 1 below ("add a `log_pipeline_run` on the success path") is **already partly shipped** — the 06-11 heartbeat does exactly this at `after()` entry. Read the route's comment at line ~192 before implementing it again.

# ⛔⛔ CORRECTION #2 — `pipeline_runs` recorded **1 of 6** `fmv-recalc` invocations. My "deterministic page-0 poison" was a SELECTION ARTIFACT.

Cowork **cloud** session, 2026-08-16 20:20Z / 13:20 PT. **This corrects my 20:15Z filing, which corrected my 16:40Z filing.** Vercel runtime logs were the instrument that settled it — the DB could not.

> ⚠ **Scope line.** NO-PUSH is specific to **this cloud Cowork session**. Trevor's machine and Claude Code push normally. **Commit as usual.**

## The measurement

Window **19:31:58Z → 20:16:58Z** (45 min), same window both instruments:

| instrument | `fmv-recalc` invocations seen |
|---|---:|
| Vercel runtime logs | **6** |
| `pipeline_runs` | **1** |

**`pipeline_runs` is blind to 5 of 6.** Mechanism, from `app/api/fmv-recalc/route.ts`: `log_pipeline_run` is called on the **early-exit path** (`salesPage.length === 0`, the step-1b refetch-empty branch). A run that gets *past* that branch and then dies at **`Vercel Runtime Timeout Error: Task timed out after 300 seconds`** writes **no row at all**.

👉 **So `pipeline_runs` for `fmv-recalc` is a census of FAST FAILURES ONLY.**

## ⛔ What that does to my own claim

At 20:15Z I wrote: *"21 runs, 0 ok, 21 at offset zero, 100% failure across a 10× swing in load — page 0 is deterministically poison, invariant to load."*

**The 21/21 is real but it is not a failure rate.** It is 21 members of the fast-fail subset, with the rest of the population invisible. **A denominator I could not see.** This is the repo's own documented *"a failures-only query reads as 100% failing"* trap — and I hit it today in **both** directions: first trusting the route's `(saturation-class)` self-label, then treating a filtered subset as a population.

⚠ **And the load-invariance argument dies with it.** The failing subset is selected *by* fast failure, so of course it looks load-insensitive. The actual error, from the logs, is `canceling statement due to statement timeout` — which **is** load-sensitive. My own EXPLAIN understated it: 6,788 ms warm-ish with **25,892 blocks read from disk** and **1,950 ms of planning alone**. Cold, under IO saturation, that clears the budget.

## What is actually happening — the sweep is working hard and never finishing

The invisible runs are doing real work. From the logs (20:15:36Z):

```
[FMV-RECALC] Wash-trade filter: removed suspicious clusters from 231 editions
[FMV-RECALC] 90d catch-up: seeded 789 zero-30d Top Shot editions for 90d pricing
[FMV-RECALC] 90d catch-up: seeded 340 zero-30d All Day editions
[FMV-RECALC] Processing 1629 distinct editions
[FMV-RECALC] 90d window extension: widened 1233 thin editions (13585 sales)
```

…and then, repeatedly across runs, **`Task timed out after 300 seconds`**.

**The cursor never advances because the run dies before writing `cursor_after`** — which is why `fmv_sweep_wedge_hours` (13.40 vs breach 3) is still correct and still climbing. **That half of the 16:40Z finding stands: the catalogue pass is not progressing.** What was wrong was the *cause*.

⚠ Even the deep runs are riddled with internal statement timeouts that the route swallows as non-fatal:
`90d catch-up enumeration error for Top Shot (non-fatal)` · `90d extension fetch error (slice 0, range 1000)` · `Historical fallback query error` — all `canceling statement due to statement timeout`.

## ⓘ Unverified but worth one look: TWO callers with DIFFERENT secrets

```
GET  /api/fmv-recalc  received: "0a5db548…"  expected INGEST: "9c74906d…"   -> 200
POST /api/fmv-recalc  received: "9c74906d…"  expected INGEST: "9c74906d…"   -> 200
```

Both authorise (the route evidently accepts `CRON_SECRET` as well as the INGEST token). In this window the **GET** invocations are the ones that fast-fail on the sales refetch and the **POST** ones do the deep work. **I am NOT claiming the caller causes the difference** — the sample is 6 and cold-cache timing is a sufficient explanation. But two schedulers driving the same expensive route is worth confirming against the [two-schedulers-run-the-same-fmv-propagation] filing from 08-14.

## Revised recommendation

1. ⛔ **Do not act on `pipeline_runs` for this route until it logs on completion too.** The one-line fix is a `log_pipeline_run` on the success path and on the 300s-adjacent exits; without it every future measurement of this sweep is drawn from the same biased sample.
2. **The real ceiling is the 300 s `maxDuration`, not the page.** A pass that processes 1,629 editions, seeds 1,129 catch-ups and widens 1,233 thin editions cannot finish in 300 s under current IO. **Resumability — write `cursor_after` before the wall — is worth more than a bigger budget**, and is the same conclusion the `refresh_wmc_fmv_drift_active` finding reached today from the other end.
3. `fmv_sweep_stall_pct_24h` (**53.6**, fired) and `fmv_sweep_wedge_hours` (**13.40**) are both reporting truthfully. Leave them.
4. ⚠ The `breach_at 50` calibration question is **unchanged and still Trevor's call** — but note the arm's input is drawn from the same biased sample as everything else here.

## Method note for the ledger

**Three passes over one symptom produced three different causes.** DB-only evidence gave "saturation" (the route's own label), then "deterministic poison page" (a filtered subset read as a population). **Only the Vercel runtime logs — the instrument the repo already documents as the real one for this class — showed the invocations the database never recorded.** When a route logs conditionally, the DB is a *sample*, not a *census*, and nothing inside the DB can reveal that.
