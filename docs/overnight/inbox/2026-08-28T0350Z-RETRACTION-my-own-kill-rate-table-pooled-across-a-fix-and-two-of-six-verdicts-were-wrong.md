# ⛔ RETRACTION — my own kill-rate table **pooled across a fix**, and two of six verdicts were wrong. The instrument now lives in code.

**Filed 2026-08-27 20:50 PT (2026-08-28 03:50Z) by Claude Code, cloud session (push-capable).**
Corrects §1 of [2026-08-28T0330Z](2026-08-28T0330Z-compute-laliga-pack-ev-has-written-ZERO-rows-in-its-entire-life-and-its-failure-was-protecting-us.md)
and §5 of the same, and the closing line of
[2026-08-28T0305Z](2026-08-28T0305Z-candy-editions-ingest-is-killed-45pct-of-nights-and-every-kill-is-invisible-in-both-rollups.md).

✅ **SHIPPED:** `lib/pipeline/kill-rate.ts` + `scripts/analysis/killed-after-routes.mjs` + 17 tests.

---

## 1. ⛔ The claim I retract

The 0330Z filing published this table and concluded that `candy-listings-indexer`
*"was 'fixed' on 08-26 and is still killed on 58 % of ticks, which is its own investigation."*

**That is wrong.** The kills are a **contiguous block that ended**. Splitting the identical rows at
the deploy that landed **2026-08-27 03:48Z** (`6455fb9f9`, *batch per-page mint resolution — ~1,600
sequential round trips become ~32*):

| era | ticks | killed | % | avg duration |
|---|---:|---:|---:|---:|
| **PRE-fix** | 16 | 14 | **87.5 %** | **322 s** (of a 300 s wall) |
| **POST-fix** | 9 | **0** | **0.0 %** | **28.5 s** |

**11× faster, zero kills, and it holds at the peak hour** — the 18:35Z tick completed in 34.2 s.
The fix is **verified working**, and my filing reported it as a continuing failure.

✅ **And the user-facing question is settled: the public `/insights/candy-mlb` board is NOT stale.**
`candy_listings` `max(last_seen_at)` is **2.4 minutes old**, 2,025 active rows. There is no outage.
⚠ Note the freshness column is **`last_seen_at`**; `candy_listings` has no `snapshotted_at`.

## 2. ⭐ The mechanism of my error, which is the part worth keeping

My table had exactly two columns of evidence: **`killed`** and **`%`**.

🚨 **A kill rate with no recency discriminator cannot tell "broken now" from "was broken, fixed, and
the pooled rate still carries the corpse."** Both records produce 56 %. Only the ORDER separates them,
and I did not look at the order.

⚠ **The aggravating detail: the fix date was IN MY OWN SENTENCE.** I wrote *"was fixed on 08-26"* and
still averaged across it. Knowing the boundary is not the same as splitting on it.

Re-running the same sweep with `last_kill` vs `last_ok` added — one extra column pair — **flips two of
the six flagged pipelines**:

| pipeline | pooled % | last kill | last ok | corrected verdict |
|---|---:|---|---|---|
| `candy-listings-indexer` | 56.0 | 08-27 00:35 | **08-28 03:35** | ✅ **RECOVERED** |
| `pinnacle-sync` | 66.7 | 08-26 10:07 | **08-27 10:07** | ✅ recovered (⚠ n=3, weak) |
| `fmv-recalc` | 62.3 | **08-28 03:35** | 08-28 03:28 | ⚠ ongoing — stands |
| `compute-laliga-pack-ev` | 100 | 08-27 05:30 | **never** | 🚨 stands |
| `candy-editions-ingest` | 33.3 | **08-27 22:10** | 08-26 22:10 | 🚨 stands |
| `lock-check-batch` | 25.0 | **08-28 03:38** | 08-28 03:08 | ⓘ new tonight, n=4 |

✅ **The two actions I shipped tonight on this table are unaffected**, because both were verified by a
second instrument before shipping: `compute-laliga-pack-ev` against the indefinite
`pipeline_runs_daily` (20 runs, 0 rows written, lifetime), and `candy-editions-ingest` against the
heartbeat-vs-terminal DAY rollup across 22 days. **The two rows that flipped are the two I did not
independently corroborate.** ⭐ That is not a coincidence, and it is the argument for the rule.

## 3. ✅ What shipped, so this cannot recur by hand

The heartbeat correlation is **the only instrument on this platform that can see a killed `after()`
route** — and it lived **nowhere**. It was re-derived ad hoc every time it was wanted, which is
precisely how it was re-derived wrong.

**`lib/pipeline/kill-rate.ts`** — `classifyKillRecord()` and `correlateRuns()`.
⭐ **It does not accept a rate.** It requires the tick sequence and derives recency from it, so
**there is no way to call it with the two columns that misled me.** Verdicts: `healthy` · `failing`
(most recent tick killed) · `recovered` · `intermittent`.

⭐ **The recovery test is a TEST, not a threshold.** "How many clean ticks mean recovered?" has no
constant answer — 9 clean ticks is decisive after an 87 % failure rate and meaningless after 20 %. So
it asks the falsifiable question instead: **p = (1 − killRate)^cleanTicks**, the chance of this run
under the null that nothing changed. ⚠ **Pooling is used deliberately and is the CONSERVATIVE
direction**: it deflates the null rate (56 % rather than the broken era's 87.5 %), which *raises* p and
makes `recovered` **harder** to reach. The test can under-call a recovery; it cannot manufacture one.

⚠ **Stated limits, in the module header:** independence is an assumption (kills cluster by hour and by
deploy), so p is a discriminator, not a significance level. And `recovered` means *the kills stopped* —
**never that anyone knows why.** Attributing a cause is a human naming a deploy from the git log.

**`scripts/analysis/killed-after-routes.mjs`** (`npm run pipelines:kills`) — read-only runner.

## 4. ✅ How the instrument itself was verified

⚠ CLAUDE.md: *prove a watcher can see a FAILURE before relying on it.* No service-role key exists in
this sandbox, so the script cannot be run against prod from here. **So the part that was wrong is the
part under test** — the correlation, not just the arithmetic:

- The **real 25-tick candy record** is a fixture, as raw `pipeline_runs` rows. It reproduces 25/14/56 %
  and returns `recovered`.
- **NEGATIVE CONTROL:** the same 14 kills moved to the END returns **`failing`**. Identical count,
  identical rate — only the order differs. If that ever returns `recovered`, recency has stopped being
  consulted and the module is back to reporting a bare percentage.
- **POSITIVE CONTROL:** delete the terminal rows and all 25 ticks read as killed — so a correlation
  that matched *nothing* cannot pass the main test for the wrong reason.
- A terminal row 60 s away does not clear a kill; a `-retry` sibling is not absorbed by its prefix.
- **The failure path is exercised live:** pointed at an unreachable host it prints `could not measure:`
  and exits **2**, not a clean report.

⭐ **Exit codes are three-state on purpose: 0 nothing failing · 1 failing now · 2 could not measure.**
Collapsing 1 and 2 would let a read failure render as a finding — the exact defect class this module
is about, in the instrument built to detect it.

⚠ **One honest gap:** `intermittent` and `recovered` do **not** exit non-zero. A check that goes red on
history stays red forever and stops being read.

## 5. ⚠ What is NOT claimed

- ⛔ **`pinnacle-sync`'s recovery is n=3 and p=0.33 — the classifier correctly refuses to call it.**
  One clean tick after two kills is not evidence. It is listed above as a *direction*, not a finding.
- ⛔ **`lock-check-batch` cannot be read yet.** I added its heartbeat tonight, so n=4 *is* its entire
  history; its one kill may be routine. Recorded so a future sweep does not mistake a new instrument
  for a new fault.
- ⛔ **`fmv-recalc` at 62.3 % is untouched and stands** — CLAUDE.md documents it as wasteful-not-broken
  at 64–73 %, and 62.3 % reproduces that figure by another method. It remains the positive control for
  the whole sweep.
- ⛔ **The ~73 h `pipeline_runs` retention bounds everything here.** A pipeline absent from the report
  has no heartbeat in the window, and un-heartbeated, idle and never-firing all look identical. **A
  short report is not a clean bill of health**, and the script's header says so.

## 6. Revert

`git revert` the commit. Removes `lib/pipeline/kill-rate.ts`, `scripts/analysis/killed-after-routes.mjs`,
`__tests__/pipeline-kill-rate-classify.test.ts` and the `pipelines:kills` script entry. **Nothing
production-facing changes** — no route, no schedule, no DB object. This filing's corrections stand
regardless of the code.
