# `compute-golazos-pack-ev` is SETTLED: not cron, not retention, NOT saturation — and the freshness arm reads green through it

Filed 2026-08-18 07:06 PT / 14:06Z (Claude Code, interactive). **Read-only.** Answers the one item
[the overnight handoff](../../handoff-2026-08-18-overnight-pass.md) named as actionable-but-unrun
(*"verify whether its cron is firing"*), and closes the *"unconfirmed either way"* verdict in
[2026-08-18T0013Z](2026-08-18T0013Z-golazos-pack-ev-silent-17h-and-team-roster-rpc-timeout.md).

## What is now established, by measurement

| question | answer | how |
|---|---|---|
| Is the cron firing? | **YES** — jobid 44 `rpc-compute-golazos-pack-ev`, `37 */6`, `active`, 5 fires since the break, all `succeeded` in 0.1–3.2 s | `cron.job_run_details` |
| Is the silence a retention artifact? | **NO** — retention floor is **2026-08-15 12:41Z**; the pipeline has 6 rows and then stops | `min(started_at)` over the whole table |
| When did it actually stop? | last `pipeline_runs` row **2026-08-17 06:37:31Z**; last write **06:41:24Z** | `pipeline_runs` + `pack_ev_history` |
| Is the board really stale to users? | **YES — 31 h 21 m** | `max(snapshotted_at)` on the OUTCOME table |

⚠ **`cron.job_run_details` says `succeeded` for every one of those 5 fires.** The job body is
`net.http_get`, so that records the **ENQUEUE**, not the run — already documented, restated only
because the green status is what makes this look fine from the operator's usual angle.

## 🚨 The finding that changes the disposition: a POSITIVE CONTROL rules out saturation

Every prior note on this — the 0013Z filing and tonight's handoff — leaned on *"likely saturation
collateral"*. **That is refuted.** `pack_ev_history`, newest row per collection, one instrument, same
instant:

| collection | newest pack-EV write | staleness |
|---|---|---|
| **laliga_golazos** | **2026-08-17 06:41:24Z** | **31 h 21 m** |
| nfl_all_day | 2026-08-18 05:38:49Z | 8 h 24 m |
| nba_top_shot | 2026-08-18 10:25:28Z | 3 h 37 m |
| disney_pinnacle | 2026-08-18 12:17:42Z | 1 h 45 m |

**The three sibling pack-EV pipelines are writing normally through the same saturation.** A
platform-wide IO problem does not stop one collection and spare three. **This is golazos-specific, and
the saturation attribution should not be carried forward.**

⚠ This matters beyond one board: *"it's the saturation"* is the single root cause the focus doc tells
every session not to re-investigate. That instruction is right in general and **wrong here** — it is
exactly the shape that lets a real, separate fault sit for 31 hours wearing a known-class label.
**A blanket root cause needs a per-item control before it absorbs a new symptom.**

## 🚨 Second finding: the arm that exists to catch this is reading BELOW the maximum

`pack_ev_board_max_stale_days` = **0.90 days**, `status: ok`, `breach_at: 2` — while the worst
collection sits at **1.31 days**. An arm whose name is `max_stale_days` is publishing a number lower
than the max. So **a 31-hour-stale public board raises nothing**, and the arm's stated purpose
(*"catches: stale pack-EV board (hit 44d on 2026-06-05)"*) is not being served for this collection.

⚠ **A HYPOTHESIS, EXPLICITLY NOT A MEASUREMENT.** The sibling arm's own description says the freshness
arm *"reads a board that is already published"* — so if golazos packs are absent from
`pack_ev_latest`, their staleness is invisible to it by construction, the same
silent-by-construction shape as the guards fixed on 08-17. **I could not confirm it:** two attempts to
read `pack_ev_latest` grouped by collection **both hit the MCP 60 s cap** (which abandons the result,
not the query), consistent with the saturation the handoff documents. **Do not act on this half until
someone reads `pack_ev_latest` for `laliga_golazos` directly.**

## What I did NOT establish

- **Why the edge function stopped.** Failing, running-and-killed-before-the-completion-write (the
  documented `rows_written`-is-a-null-instrument class), or not running at all — all three still fit.
  `pipeline_runs` cannot separate them because it logs on completion. **The decisive next step is the
  edge function's own Supabase logs**, which this session did not read.
- **Whether the golazos board degrades honestly to a user.** Not checked. If it renders a stale EV as
  current with no age, that is a separate and higher-severity item than the staleness itself.

## Disposition

⛔ **Not shipped, and not shippable by an autonomous pass:** pack-EV route logic is on CLAUDE.md's
never-auto-ship list, and the arm change is a trust-board migration. Both need Trevor.

**Cheapest next steps, in order:** (1) read the `compute-golazos-pack-ev` edge-function logs for
2026-08-17 06:37Z onward — that alone probably names the cause; (2) read `pack_ev_latest` for
`laliga_golazos` when the DB is quiet, to confirm or kill the arm-blindness hypothesis; (3) only then
decide between fixing the function and fixing the arm. **They are separate defects — fixing the
function would make the board fresh again and leave the arm just as blind to the next one.**
