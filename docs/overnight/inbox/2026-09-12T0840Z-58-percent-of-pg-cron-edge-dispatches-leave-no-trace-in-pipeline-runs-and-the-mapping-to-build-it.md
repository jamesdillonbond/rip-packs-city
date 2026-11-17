# 🔴 **58 % of this estate's pg_cron edge-function dispatches leave NO trace in `pipeline_runs` — five jobs, 1,392 dispatches a day, invisible to every instrument built on that table**

**2026-09-12T08:40Z (2026-09-12 01:40 PT) · Claude Code (cloud), autonomous session · instance quiet at measurement.**

Register **#79** describes a fourth lane state nothing watches — *"ran, succeeded, found NOTHING"* — and proposes a detector over `pipeline_runs`. ⛔ **There is a state beneath it that the same detector cannot see either: a lane that logs NOTHING AT ALL.** In that table, *"ran and found nothing"* and *"does not exist"* are the same row — namely, none. **A zero is not a null, and only the zero is visible to any `pipeline_runs` predicate.**

#79 could not be sized because there is no derivable job→pipeline-name mapping. **This filing builds one and sizes it.**

## The measurement

**12 active pg_cron jobs dispatch to a Supabase edge function, 2,409 times per 24 h.** Of those, **five jobs — 1,392 dispatches/day, 57.8 % — have no counterpart in `pipeline_runs` or `pipeline_runs_daily`:**

| jobid | job | callee | dispatches/24 h |
|---:|---|---|---:|
| 25 | `rpc-allday-pack-sales-backfill` | `backfill-allday-pack-sales` | **480** |
| 29 | `rpc-topshot-pack-sales-backfill` | `backfill-topshot-pack-sales` | **480** |
| 27 | `rpc-allday-dist-opened-backfill` | `backfill-allday-dist-opened` | **360** |
| 22 | `rpc-allday-resolve-pull-editions` | `resolve-allday-pull-editions` | 48 |
| 26 | `rpc-allday-resolve-rip-dist-api` | `resolve-allday-rip-dist-api` | 24 |

## ⭐ Four independent instruments, because a name search alone would not be worth much

1. **Name search over the FULL history.** `pipeline_runs_daily` is indefinite and holds **248 distinct pipeline names ever recorded**. Matching `%pack-sales%`, `%pull-edition%`, `%rip-dist%`, `%dist-opened%` returns **0 of 248**.
2. **⭐ CADENCE search, which is name-independent and is the instrument that makes this stick.** Two of these jobs dispatch **480×/day**. Across every lane that logged yesterday, the count with **440–520 runs is ZERO** — there is no lane of the right shape hiding under an unrelated name.
3. **Source inspection.** `resolve-allday-rip-dist-api` is in the repo and contains **no `pipeline_runs` write path at all** — no `log_pipeline_run`, no `logPipelineRun`, no `from("pipeline_runs").insert`.
4. **Independent documentation.** Migration `20260901071258`, written by someone who read the deployed source of `backfill-allday-dist-opened`: *"It writes NO pipeline_runs row, so nothing watched the silence."*

⚠ **RESIDUAL UNCERTAINTY, STATED:** a lane could log under a name bearing no resemblance to its callee, which instrument (1) would miss. Instruments (2)–(4) are what close that gap for the two largest jobs and one of the small ones; **jobid 22 rests on (1) and (2) alone.** ⚠ And (2) is suggestive rather than conclusive on its own — a lane that logs only when it does work would show few runs rather than ~480.

## 🚨 THE MAPPING, and why nobody had it: there are THREE logging idioms, not one

Across the **38 in-repo edge functions**:

- **25** yield at least one pipeline-name literal
- **1** (`backfill-pack-opens-api`) calls a logging path with a non-literal name — needs hand resolution
- **12** contain **no `pipeline_runs` write path at all**: `backfill-allday-pack-supply`, `enrich-ufc-wallet`, `flowty-proxy`, `resolve-allday-rip-dist-api`, `scan-pinnacle-wallet`, `scan-ufc-wallet`, `seed-allday-pack-distributions`, `seed-topshot-pack-distributions`, `seed-ufc-editions`, `special-serial-delta`, `special-serial-sweep`, `sync-nba-games`

⭐ **Three different idioms write that table, which is precisely why every static mapping attempt produces FALSE ZEROS — including my own first two:**

```
1.  logPipelineRun("literal-name", …)
2.  const pipeline = "literal-name";  logPipelineRun({ pipeline, … })      // ingest-pinnacle-mints
3.  supabase.from("pipeline_runs").insert({ pipeline, … })                  // ingest-topshot-pack-opens-history
```

⚠ **I got this wrong twice before getting it right, and both errors are the same error.** A first pass matched pg_cron callees against pipeline names and reported jobid 56 as silent — it logs as `topshot-pack-opens-history-backfill` while its callee is `ingest-topshot-pack-opens-history`. A second pass grepped for `logPipelineRun("` and reported `ingest-pinnacle-mints` as silent — it logs through a variable. **Both times the tool answered "no evidence" and I nearly read it as "evidence of no".** The fix that worked was a POSITIVE regex for *any* write path (`log_pipeline_run|logPipelineRun|logRun\(|from("pipeline_runs")`), evaluated separately from name extraction — **so "logs but I could not name it" is a distinct answer from "does not log".** That separation is the whole difference between a mapping and a guess.

## Why it matters, beyond #79

- **Every arm in `get_pipeline_alerts_core()` that reads `pipeline_runs`** — `cron_silent`, the failure-rate arm, `detect_stalled_pipelines()`, and the cadence arm shipped last night — is structurally blind to these five lanes. They cannot go silent, cannot fail, and cannot degrade, because they cannot be observed.
- ⭐ **The 2026-09-11 cadence-collapse finding is the proof this is not hypothetical**: nine lanes ran at 1/12th cadence for two days with three instruments green. These five are one level worse — they have no instrument at all.
- ⚠ `cron.job_run_details` is NOT a substitute. It records the **dispatch** of a `net.http_get`, not the outcome; #74 records jobid 15 reading `status=succeeded` / `"1 row"` while its work 530s. **The scheduler is the one that lies.**

## Recommended, in order

1. ⭐ **Cheapest and needs no deploy: an OUTCOME-table check per lane** — `count(DISTINCT <stamp>::date)` on the table each one fills. It measures the result instead of the self-report, which is CLAUDE.md's own rule, and it works on a lane that logs nothing.
2. **Add the missing `pipeline_runs` write to the five callees.** Four of the five are **deployed-only** (`backfill-allday-pack-sales`, `backfill-topshot-pack-sales`, `backfill-allday-dist-opened`, `resolve-allday-pull-editions` have no source in this repo), so that is an operator/device-bound task, not a sandbox one. ⛔ **And it is the same blocker `20260901071258` already recorded** for the All Day hydrator: an edge redeploy gated on a hardcoded key literal.
3. **Commit the four missing sources first.** *"The source is not in the repo"* is the upstream cause of every one of these being unknowable from here, and it is a bigger problem than the logging.

## Re-check condition

Re-run instruments (1) and (2). **A lane is fixed when a pipeline name appears whose 24 h run count is within ~10 % of its job's dispatch count** — 480, 480, 360, 48, 24 respectively. Anything materially below that is a lane logging only on work done, which is a different (and still readable) shape.
