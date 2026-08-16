# ✅ VERIFIED 16:47Z — the `:13` collision fix passed its positive control. And the "contradiction" was never one.

Cowork **cloud** session, 09:47 PT. Measured. **Nothing changed by this session.**

> ⚠ **Scope line.** NO-PUSH is specific to **this cloud Cowork session**. Trevor's machine and Claude Code push normally via the PAT in `remote.origin.pushurl`. **Commit these files as usual.**

## The control

At 16:34Z jobid **332** `rpc-refresh-special-serial-owners-mv` (`43 4,16 * * *`, `cron_heavy`) had **zero runs, ever** — so "the `:13` collision is FIXED" described an intention, not an outcome. First fire was due 16:43Z.

| | |
|---|---|
| `start_time` | **2026-08-16 16:43:00.24Z** |
| `status` | **`succeeded`** |
| duration | **2 m 55 s** (in family with job 109's historical ~82–173 s) |
| `return_message` | `1 row` |
| owner | **`cron_heavy` — preserved through the recreate** |

Job **71** `rpc-backfill-historical-pack-ev` confirmed untouched at `13 * * * *`. **PASS. The concurrent session's ledger entry is correct as written and needs no qualifier.**

## The apparent contradiction was a scope collision, not a factual one

Both documents are correct because they assert different things:

- **"the `:13` collision is FIXED"** — a claim about **state**. True: jobid 109 (`13 4,16`) is gone from `cron.job`; its last run was 16:13:02.46Z, **0.25 s** after job 71's 16:13:02.71Z — so the collision was real and live this morning. Minute 13 now holds job 71 alone.
- **`2026-08-16T1520Z-the-13-stagger-is-REFUTED-do-not-run-it.md`** — a claim about a **proposed remedy**. Also true, and it refutes a block nobody executed: it argued against moving job 71 → `40 * * * *` and job 109 → `25 4,16`. The fix that shipped did **neither** — it left job 71 alone and sent 109 to **:43**, sidestepping both named hazards.

⚠ **The refutation's numbers were understated, so it is stronger now than when written.** Live active-job counts by start minute: **:13 → 1** (71) · **:43 → 1** (332) · **:25 → 4** (4, 54, 217, 256) · **:40 → 4** (19, 67, 198, 249). The filing described :40 as 2 jobs and :25 as jobid 4 alone. **Do not run that block.**

ⓘ Neutral: jobid **16** `rpc-backfill-pack-pool` runs every 5 min (`3,8,13,…,43,…`), so it sits on **:13 and :43 alike** — moving 109 between them is a wash on that axis.

## ⛔ What this does NOT change

The refutation's deeper result is untouched: **overlap tracks a job's DURATION, not its start minute.** Job 71 at p95 531 s spans ~9 minutes and overlaps whatever starts in that window. Removing a 2 h/day two-job overlap is a real but small win and does not address a schedule oversubscribed **in duration**. The lever stays the WORK (page size, fan-out, budget isolation), never the clock.

## Two rules worth keeping

1. **Before arbitrating two documents that look contradictory, check they are asserting the same proposition.** A *state* claim and a *remedy* claim shared the topic string ":13" and nothing else. "One of these must be wrong" was the wrong frame.
2. **A reschedule is not a fix until the new job has fired.** Jobid 332 looked perfect in `cron.job` — right name, command, owner, `active = true` — for three hours before it had ever run. **`cron.job` records intent; only `cron.job_run_details` records outcome.**
