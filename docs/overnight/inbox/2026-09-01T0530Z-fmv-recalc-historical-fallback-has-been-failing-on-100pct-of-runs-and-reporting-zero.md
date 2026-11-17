# 🚨 fmv-recalc's historical-sales fallback has been failing on 100% of runs, reporting `historicalFallback=0`, and starving 4,277 editions of FMV

**Filed 2026-08-31 ~21:4x PT (2026-09-01 ~04:4xZ) by Claude Code from Trevor's Windows box.**
Found while verifying a *different* change I had just deployed — not by looking for it.

## How it surfaced

I shipped the Step 5c/5d/5e LATERAL rewrite (filing `2026-09-01T0400Z…`) and went to confirm it
actually ran in production rather than trusting `ok: true`. `pipeline_runs` cannot show it — the route
calls through `query_sql`, and pgss `track='top'` hides nested statements — so I read the Vercel
runtime logs. My change was fine (Step 5e logged *"parallel ASK floor: 3 STALE/NO_DATA :: editions with
a live ask"* → *"3 :: editions floored"*, a positive control). **But every single run also carried this:**

```
[FMV-RECALC] Editions missing FMV snapshots: 171
[FMV-RECALC] Historical fallback query error: canceling statement due to statement timeout
```

Ten consecutive runs in the log window. Then, from `pipeline_runs.extra`:

| day | fmv-recalc runs | runs with `historical_fallback > 0` |
|---|---:|---:|
| 2026-08-29 | 43 | **0** |
| 2026-08-30 | 129 | **0** |
| 2026-08-31 | 148 | **0** |
| 2026-09-01 | 30 | **0** |

**350 of 350 runs. It has never once succeeded inside the whole `pipeline_runs` retention window.**

## ⭐ Why nobody saw it — this is the honesty class, pointed at an operator

The step's failure is **indistinguishable from its success** on every instrument that anyone reads:

- `pipeline_runs.ok` = **true** (the other steps succeeded)
- `pipeline_runs.rows_written` = **healthy** (499, 1394, …, from the main sweep)
- `extra.historical_fallback` = **0** — which reads as *"nothing to do"*, not *"could not run"*
- the summary line says `historicalFallback=0`, same ambiguity
- the only trace is a `console.warn`, and **Sentry has been dark since 08-18 (#34)**

This is CLAUDE.md's top defect class with the audience changed: not a user being told "0 moments", but
an *operator* being told a step found nothing when it never completed. `rows_written = 0` is already on
record as a null instrument; **`extra.<step> = 0` is the same null instrument one level down**, and it
had no error field beside it to disambiguate.

## The cost of the silence

| | |
|---|---:|
| editions qualifying for the step | **8,571** |
| …of those, with paid sales (i.e. actually convertible here) | **4,277** |
| editions the step has covered in 4 days | **0** |

Those 4,277 carry either a pre-`1.7.x` snapshot or a `NO_DATA` one — the population this step exists to
re-price. The fix moves them out of stale/no-FMV and into honest low-confidence labels.

### ⛔ CORRECTION to my own first reading — the `171` is a DIFFERENT population, and this step cannot touch it

I initially bracketed the constant `Editions missing FMV snapshots: 171` with this finding, because the
two lines sit next to each other in every log entry. **Checked rather than assumed: all 171 of those
editions have ZERO paid sales.**

```
missing_total 171 · with_paid_sales 0 · no_paid_sales 171
```

So the historical-sales fallback could never have covered them — **not before this change and not
after** — because the original `JOIN sales` excluded them exactly as the new `EXISTS (sales)` does. They
are Step 5's domain (the `badge_editions.low_ask` proxy backfill) or genuinely unpriceable, and the
`171` being constant across runs is **not** evidence about this step. Two numbers appearing on adjacent
log lines is not a relationship; this one would have inflated the finding by ~4% and, worse, would have
sent the next reader looking for the 171 in a step that structurally cannot reach them.

## Why it could never finish

`LIMIT 1000` sat **after** the `GROUP BY`. The planner therefore merge-joined **all** editions against
**4,853,937** sales rows and aggregated **25,595** groups before the limit could discard anything, while
a `DISTINCT ON` over all **1,369,480** snapshot rows ran alongside it. Textbook *"a `LIMIT` bounds a
query's OUTPUT, not its COST"*.

## The fix — pick candidates first, and cut ITEMS per tick

Per-edition LATERAL for the latest snapshot (same predicate term-for-term), bound **that** to a small
batch, and only then join sales and aggregate:

| shape | result |
|---|---|
| original | **TIMES OUT (>30 s), 0 rows, every run** |
| candidate-first, `LIMIT 1000` | 29,904 ms / 265,372 buffers — sitting on the 30 s wall |
| **candidate-first, `LIMIT 200`** ← shipped | **6,981 ms / 75,418 buffers** |

Cutting items per tick rather than rows per item, per the standing rule. At ~5 ticks/hour that is
~1,000 editions/hour, so the 4,277 backlog clears in roughly 4 hours and the step then idles.

### ⚠ The `EXISTS (sales)` placement is load-bearing — outside the CTE it would STARVE

**4,294 of the 8,571 qualifying editions have no paid sales and can never be converted by this step.**
If they were allowed into the bounded candidate set they would sit at the head of an unordered `LIMIT`
forever, be re-picked every tick, and the convertible editions would never be reached — the
`limit-before-join-starves-a-backfill` shape, where a tick gets fast and still converts zero. Keeping
`EXISTS` inside the candidate CTE is what makes the head advance. Converted editions leave the set on
their own: every insert branch stamps `algo_version = ALGO_VERSION` and a confidence of
`ASK_ONLY`/`SALES_ONLY`/`STALE`/`LOW` — **never `NO_DATA`** — so they fail the predicate next tick.

### Equivalence — proven, and not vacuously

Both forms run unbounded over a hash-bucket sample (`abs(hashtext(id::text)) % 40 = 0`), comparing the
**full aggregate output** (avg, min, count, latest_sold_at, prev_confidence), not just the id set:

**96 rows = 96 rows, `EXCEPT` 0 / 0 in both directions.**

## Also shipped: the instrument that would have caught it

`extra.historical_fallback_error` — null when the step ran, the error string when it did not — plus a
`historicalFallbackFAILED="…"` field on the summary line. **A count of 0 beside no error field cannot
distinguish "nothing to do" from "never ran", and that ambiguity is the whole reason this survived 350
runs.**

## What I would sanity-check first

Output was sampled before shipping rather than assumed: 200 candidate rows, median avg price **$28.45**,
min $0.48, max $6,213.58, **none over $10k**, 71 of 200 landing on the ASK_ONLY branch. In this head
batch 199 of 200 are the pre-`1.7.x` cohort and 1 was `NO_DATA`.

**EXIT:** within ~6 hours `extra.historical_fallback` should be non-zero on most ticks and the qualifying
population should fall from 4,277 toward 0. **FALSIFIER:** if `historical_fallback` is still 0 a day from
now, either the query is still failing — and `historical_fallback_error` will now say so outright — or
the candidate set is starving, which would show as the same edition ids being re-picked every tick.
**REVERT:** `git revert` the code commit; no DB object changed. Snapshots already written stay as history
and are repriced by the normal sweep.

---

## ⛔ CORRECTION 2026-09-01 ~17:2x PT — the fix WORKED but its exit condition FAILED, and the reason is a second, deeper defect this filing got wrong

**Post-ship watch, 18 h after deploy.** The step runs, every tick, with no errors. And the backlog did
not drain:

| | |
|---|---:|
| runs with coverage | **119** |
| editions "covered" | **23,800** |
| runs reporting `historical_fallback_error` | 1 |
| qualifying population, start → now | **4,277 → 3,382** |

23,800 writes for ~895 net progress. **That is a treadmill, not a drain.**

### The mechanism, read off one edition's snapshot history

```
00:08:29   algo 1.7.0                  ← this step writes
00:09:12   algo thin-sales-guard-v3    ← 43 s later, the thin-sales guard overwrites
```

`thin-sales-guard-v3` does not match `'1.7.%'`, so the edition is **re-admitted on the very next tick**,
forever. Two steps in the same route were fighting each other.

### ⛔ What this filing got wrong

`algo_version NOT LIKE '1.7.%'` was a **staleness PROXY** from when 1.7.x was the only writer. There are
now **eight**, and seven do not match:

| algo_version | editions | NO_DATA | older than 7d |
|---|---:|---:|---:|
| `cold-tail-1.0` | 2,537 | 10 | **0** |
| `thin-sales-guard-v3` | 615 | 0 | 3 |
| `ask_only_v2` | 86 | 0 | 0 |
| `topshot-gql-v1_haircut` | 82 | 0 | 0 |
| `allday-listing-ask-v1` | 44 | 0 | 0 |
| `topshot-gql-v1` · `ask_only_v2_haircut` · `thin-sales-guard-v3_p90clamp` | 26 | 0 | 0 |

**None of them is stale.** Measured over the same population: the old predicate admits **3,390**; a
staleness predicate admits **13** (10 `NO_DATA` + 3 older than 7 days + 0 never-priced). **99.6% of
admissions were false.**

🚨 **So this filing's headline sizing — "8,571 qualify, 4,277 convertible" — was the broken predicate's
own OUTPUT, not a measure of need.** I sized a backlog using the very predicate that was defining it
wrongly, and then quoted the result as a measurement. **That is circular, and it is the more useful
lesson here than the SQL.** The real backlog was ~13–31.

### The fix

`WHERE (la.edition_id IS NULL OR la.confidence = 'NO_DATA' OR la.computed_at < now() - interval '7 days')`

⭐ The test is now on the **PROPERTY** (snapshot age) rather than the **IDENTITY** of the writer. An
algo-version allowlist would rot again the moment a ninth writer appears; a staleness test cannot.

⚠ **Expect `historical_fallback` to read ~13–31 or 0 from here, not 200.** That is the step working on a
real backlog, not a return of the timeout — and `extra.historical_fallback_error`, added in the same
change that exposed all this, is exactly what distinguishes the two. The instrument earned its keep
within a day.

### What still stands from the original finding

The step really was failing on 350 of 350 runs; the `LIMIT`-after-`GROUP BY` really was the cause; the
candidate-first LATERAL really did take it from >30 s to ~7 s; and the count-without-an-error-field
really was what hid it. Only the **sizing** and the **admission predicate** were wrong.

### ✅ POST-SHIP on the predicate fix (2026-09-02 00:2xZ) — converged in one tick

First run on the new build, 00:28:05Z: **`historical_fallback: 31`, `historical_fallback_error: null`** —
exactly the 31 measured before shipping. Immediately after: **qualifying population = 0.** The 31 were
covered and the backlog is empty; the treadmill's cause is gone. From here the step should sit at 0 with
a null error, which is the honest "nothing to do" state and is distinguishable from the old timeout only
because that error field exists.

⚠ **ONE CLAIM FROM THE LEDGER ENTRY IS NOT VERIFIABLE THE WAY I IMPLIED, and it is an instrument trap
worth more than the claim.** I wrote that *"the 23,800-writes-per-day of redundant delete+insert should
disappear from `fmv_snapshots`"*. That reduction follows by construction (200 pairs/tick → ~0), but it
**cannot be confirmed by counting `fmv_snapshots` rows per hour**, and the obvious query actively misleads:

| hour (Z) | rows with that `computed_at` |
|---|---:|
| 16:00 – 19:00 | **57 – 148** |
| 20:00 – 23:00 | **1,643 – 4,858** |

That looks like writes exploding at 20:00Z. They did not — `fmv-recalc` ran a steady **6–7 times per
hour** across the whole span, covering 1,200–1,400 historical editions an hour throughout. **The step
writes delete-then-insert** (`.delete().gte("computed_at", todayStart)` before each insert), so an
edition re-processed an hour later has its earlier row **removed**. A `count(*) … GROUP BY hour` therefore
measures **what SURVIVED**, not what was written, and older hours are systematically hollowed out by
later ticks.

⭐ Same shape as the recorded `unmapped_sales` lesson — *a staging queue is not a log; resolved rows are
DELETEd, so all-rows windows are survivorship-biased* — in a different table. **On any delete-then-insert
table, row counts over time are not a write rate.** To measure this properly you need the writer's own
counters (`extra.historical_fallback`) or `pg_stat_user_tables.n_tup_ins`, not the table's contents.
