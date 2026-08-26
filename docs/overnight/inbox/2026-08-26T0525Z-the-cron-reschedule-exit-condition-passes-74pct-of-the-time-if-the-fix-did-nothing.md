# Candidate: the stated exit condition for the pg_cron re-stagger is ~74% likely to PASS even if the fix did nothing

**Source:** live measurement 2026-08-25 22:18 PT (2026-08-26 05:18Z), Claude Code interactive, after Trevor said he would "confirm on tomorrow's monitor tick that `check_pgcron_recent_failures()` shows the three startup-timeout jobs gone quiet." Risk: **MEASUREMENT / DOCS** — no code, no DB write. Read-only against `cron.job`, `cron.job_run_details`, `pg_proc`.

## The finding — the instrument reports LATEST-RUN status, not "has this job been failing"

`check_pgcron_recent_failures()` ends with:

```sql
where l.status = 'failed'     -- l = the job's LATEST run in the window
```

So a job is listed **only if its most recent run failed**. It is not a count of failures in the window; `fails_in_window` is merely a column on rows that already passed that gate. Consequences, measured against the three re-staggered jobs (`2f2736c5`, ledger 2026-08-25):

| job | schedule (new) | startup timeouts / runs retained | P(one tick clean \| fix did nothing) |
|---|---|---|---|
| 198 `rpc-weekly-log-purges` | `54 9 * * *` | **4 / 38 = 10.5%** | 89.5% |
| 249 `rpc-refresh-players-current-team` | `56 9 * * *` | **4 / 23 = 17.4%** | 82.6% |
| 331 `rpc-thp-leg-pinnacle-fmv-share` | `55 3,9,15,21 * * *` | **8 / 39 = 20.5%** | 79.5% |

- 🚨 **Job 331 is ALREADY absent from the report, and was before any tick under the new schedule** — its latest run (2026-08-26 03:09Z) succeeded, so the `l.status='failed'` gate excludes it while all 8 of its startup timeouts sit in the window unreported.
- 🚨 **`P(all three "quiet" tomorrow | the reschedule did nothing) = 1.00 × 0.895 × 0.826 ≈ 74%.`** The stated exit condition is therefore **not a test** — it is the expected outcome under the null.

## Why the snapshot misleads in the other direction too

The last three runs of 198 and 249 read `fail, fail, succeed` — a 2-in-3 failure rate, which makes one clean tick look meaningful. Over full retention the rate is **10.5%** and **17.4%**. ⚠ **A directional claim needs a distribution, not a snapshot** — the repo's own rule, and the snapshot here is wrong by ~6x in the direction that flatters the fix.

## ⚠ NO TICK HAS RUN UNDER THE NEW SCHEDULES YET — n = 0, not n = 1

Every retained run for all three jobs still fired on the OLD minute (`:40`, `:09`). The newest, job 331 at **2026-08-26 03:09Z**, predates the reschedule; 331 did **not** also fire at 03:55Z, which brackets the change to after 03:55Z. First observations: **09:54 / 09:55 / 09:56Z** (02:54–02:56 PT). `cron.job` confirms all three carry the new schedule, `active=true`, owner preserved — the config is right; only evidence is missing.

## The asymmetry that makes tomorrow's check still worth doing

- ⛔ **Silence tomorrow proves nothing** (~74% under the null).
- ✅ **A `job startup timeout` tomorrow FALSIFIES the fix immediately** — under a working reschedule the expected rate is ~0.

**So keep the check, invert its reading:** treat it as a falsifier, never as a clearance.

## Suggested exit condition (replaces "gone quiet")

Count `status='failed' AND return_message ILIKE '%startup timeout%'` **per job over consecutive ticks**, not latest-run status. Clean ticks needed for p < 0.05 under each job's own baseline:

- **331 → 14 ticks ≈ 3.5 days** (4 ticks/day, highest rate). **This is the only one that settles quickly; make it the gate.**
- **249 → 16 daily ticks ≈ 16 days.**
- **198 → 27 daily ticks ≈ 27 days.** A daily job with a 10.5% failure rate simply cannot be cleared fast, and should not be the thing anyone waits on.

⚠ **Stated honestly — the arithmetic assumes independent ticks and they are NOT independent.** Failures are driven by a shared `max_worker_processes=6` spike lasting ~15 min/day, so ticks cluster; the effective n is lower and these counts are **optimistic**. Treat them as order-of-magnitude, not exact. Baselines are also modest (23–39 runs each).

**Risk read:** none — read-only. The action is a change to what we *conclude*, not to the DB.

---

## ⛔ CORRECTED 2026-08-26 05:45Z — the 74% figure is WITHDRAWN. It was **33%**, and the recommended gate was backwards.

**I made the error this filing warns about, one level up.** I replaced a snapshot with a distribution — correctly — but used a **POOLED** distribution spanning a regime change, which describes neither regime. A per-day breakdown settles it:

| job | before changepoint | after | changepoint |
|---|---|---|---|
| 198 `rpc-weekly-log-purges` | **0 / 15** (08-05 → 08-19) | **4 / 6** = 66.7% | **2026-08-20** |
| 249 `rpc-refresh-players-current-team` | **0 / 15** (08-05 → 08-19) | **4 / 6** = 66.7% | **2026-08-20** |
| 331 `rpc-thp-leg-pinnacle-fmv-share` | burst 4/8 on 08-17→18, then 3 clean days | **4 / 16** = 25.0% (08-22 →) | less distinct |

🚨 **198 and 249 fail on EXACTLY the same days** (08-20, 08-21, 08-24, 08-25 — clean on 08-22, 08-23). That perfect correlation is **direct evidence of the collision mechanism**: both sat on `40 9 * * *` and were colliding with each other. It also means **they are ONE arm, not two** — multiplying their probabilities treats correlated failures as independent and overstates the evidence.

### Corrected numbers

- **`P(the stated check passes tomorrow | the reschedule did nothing) ≈ 33%`**, not 74%. (331 contributes 1.00 — still already absent from the report; the 198/249 arm contributes 0.333. Treating them as independent would give 11%, which is *too generous*, not too harsh.)
- **The check is therefore MUCH more informative than I said.** A clean result tomorrow carries `p ≈ 0.33` under the null — not decisive, but real evidence rather than the near-no-op I published.

### Corrected gate — the ranking INVERTS

- **198 + 249 (one arm): 3 consecutive clean daily ticks ≈ 3 days.** At a 66.7% failure rate this is the *fastest and strongest* signal available. My earlier "~16 and ~27 days, so neither daily job can be the gate" was an artifact of the pooled baseline and is **withdrawn**.
- **331: 11 clean ticks ≈ 2.75 days** (25% current) — and 14 ticks on the all-retained 20.5% rate, so **11–14 is robust to the era choice**. 331 was *not* the wrong gate, but it was never the only fast one.

### What actually generalises

⭐ **"Use a distribution, not a snapshot" is necessary and not sufficient — the distribution must be REGIME-AWARE.** A pooled rate across a changepoint is a third wrong answer, sitting between the snapshot and the truth, and it is the most convincing of the three because it is computed off a large n. **Plot the series per period and look for the changepoint before quoting any rate.**
⭐ **Check whether your arms are correlated before multiplying them.** Here two "independent" jobs shared a schedule minute and failed in lockstep.

⚠ **Unchanged and still standing:** the `where l.status = 'failed'` finding (the instrument reports latest-run status, so job 331 is already absent with 8 unreported timeouts); `n = 0` — no tick has yet run under the new schedules; and the asymmetric reading (silence is weak evidence, one `job startup timeout` falsifies outright).
