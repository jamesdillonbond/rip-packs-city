# R29 — the three obvious levers for `job startup timeout` are all measured dead, and the load story does not survive its own control

**Filed 2026-09-03 ~04:00Z (2026-09-02 PT) by Claude Code. NOTHING SHIPPED — this is a
*don't-spend-an-afternoon-on-that* result.**

R29 has stood since 2026-08-22: `job startup timeout` is most pg_cron failures and writes **nothing**
to `pipeline_runs`, so the tick is lost invisibly. The 2026-08-29 pass moved three low-frequency jobs
onto quiet hours and correctly recorded that as *a workaround, not a fix*. This pass asks the next
question — **which lever actually moves it** — and the answer is none of the three anyone would try.

## 1. Re-measured, 7 days to 2026-09-03

Startup timeouts by UTC hour, alongside the launcher's own tick volume:

| UTC hour | timeouts | cron ticks | rate |
|---:|---:|---:|---:|
| **13** | **117** | 1,171 | **10.0%** |
| **9** | **65** | 1,226 | 5.3% |
| **18** | **54** | 1,328 | 4.1% |
| **14** | **45** | 1,202 | 3.7% |
| **8** | **26** | 1,242 | 2.1% |
| 0 | 10 | 1,336 | 0.7% |
| *13 other hours* | **0** | ~1,200 each | 0% |

⭐ **`cron_ticks` is FLAT across all 24 hours (1,166–1,345).** The launcher is asked to start the same
number of jobs every hour, so the band is **not** "more jobs firing".

ⓘ **13Z is the peak in two independent measurements two weeks apart** — the 2026-08-29 histogram had
13Z at 226, this one at 117/7d. Stable structure, not a spell.

## 2. ⛔ Lever 1 — re-stagger the minutes. **DEAD: real but far too small.**

There *is* a monotone concurrency effect, and it is nowhere near big enough:

| jobs launching in the same minute | ticks | timeouts | rate |
|---:|---:|---:|---:|
| 1 | 2,038 | 13 | 0.64% |
| 2 | 4,146 | 38 | 0.92% |
| 3 | 6,092 | 56 | 0.92% |
| 4 | 7,928 | 102 | 1.29% |
| 5 | 7,195 | 100 | 1.39% |
| 6 | 1,230 | 18 | 1.46% |

**2.3× from 1 job/min to 6 — against a 15× HOUR effect (10.0% vs ~0%).** And within the hot hours the
timeouts do **not** cluster on any minute (8–15 per minute across 15+ distinct minutes), so there is
no single heavy hourly job to move either. Perfect staggering would buy a fraction of one percent.

## 3. ⛔ Lever 2 — move the victims to a quiet hour. **DEAD by their schedules.**

The top victims and their cron expressions:

| job | schedule | timeouts / ticks |
|---|---|---:|
| `rpc-pinnacle-mints-backfill` | `*/2 * * * *` | 59 / 5,035 |
| `rpc-allday-pack-sales-backfill` | `*/3 * * * *` | 34 / 3,356 |
| `rpc-topshot-pack-sales-backfill` | `1-58/3 * * * *` | 34 / 3,358 |
| `rpc-allday-dist-opened-backfill` | `2-58/4 * * * *` | 29 / 2,517 |
| `rpc-backfill-wmc-fmv-confidence` | `2-59/5 * * * *` | 24 / 2,014 |

**Every one runs every 2–5 minutes, so it runs inside the band by construction.** The 08-29
workaround worked *because* its three jobs were low-frequency; **it cannot generalise**, and that is
the honest reading of why the class stands.

## 4. ⚠ Lever 3 — "we are overloading the instance then". **DOES NOT SURVIVE ITS OWN CONTROL.**

The first proxy said the band is independent of our load, and I nearly wrote that down:

- **App-side** (`pipeline_runs` work-seconds, 3d): hour **0** is the HEAVIEST at 66,638 s and has
  **10** timeouts; hour 1 at 38,274 s and hour 20 at 41,750 s have **ZERO**. Hour 14, the LIGHTEST of
  the hot hours at 10,303 s, has **45**.

⛔ **Then the DB-side control contradicted the clean version of that story**, so both halves are
recorded rather than the tidier one:

- **DB-side** (pg_cron execution seconds, 7d): the hot hours *are* generally heavier (13Z 24,100 s ·
  14Z 23,333 · 8Z 22,621 · 18Z 42,015) than the quiet ones (~10–14k)…
- …**but 12Z runs 35,955 s — the second-heaviest hour on the instance — with TWO timeouts**, and
  **9Z runs a mid-range 13,661 s with SIXTY-FIVE.**

⭐ **So DB-side load is neither SUFFICIENT (12Z) nor NECESSARY (9Z).** It is correlated and it is not
the mechanism. *"Cut the work in those hours"* is therefore not a supported prescription — which is
exactly the afternoon this filing exists to save.

## 5. What is left, and what would settle it

Nothing in the schedule and nothing in our query load explains a launcher that cannot start a worker
at 13Z while starting the same number fine at 12Z. The remaining candidates are **exogenous** — a
platform-side window on the same clock — or a **resource limit around the launcher itself**
(`max_worker_processes` / background-worker slots), which is not something a cron expression reaches.

⚠ **Both are Supabase-side questions, not repo changes.** The one measurement this session could not
take is the only one that would discriminate: background-worker slot occupancy at the moment of a
timeout. `cron.job_run_details` records the failure and nothing about the launcher's state.

ⓘ **Unchanged and still true:** the alerting arm `pgcron_startup_timeout` (≥5 in a rolling 30 min)
fires on the clusters, so this is observed even though it is not fixed — and each lost tick is still
invisible in `pipeline_runs`, which is R29's original point.
