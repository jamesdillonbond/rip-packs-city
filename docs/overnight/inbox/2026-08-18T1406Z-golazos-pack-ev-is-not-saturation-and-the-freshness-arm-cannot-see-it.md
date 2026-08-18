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

✅ **RESOLVED 2026-08-18 14:2xZ — and the answer is worse than the hypothesis it replaces.**

My hypothesis was that golazos packs are absent from `pack_ev_latest`, so the freshness arm cannot see
them. ⛔ **REFUTED.** `pack_ev_latest` is a plain VIEW (`relkind='v'`) — `SELECT DISTINCT ON
(pack_listing_id) … FROM pack_ev_history ORDER BY pack_listing_id, snapshotted_at DESC` — with **no
recency cutoff and no collection exclusion**. Stale golazos packs ARE published, carrying their stale
`snapshotted_at`. (It being a view, not an MV, is also why every read of it timed out: it recomputes a
DISTINCT over ~203k rows on each call, despite a cron named `rpc-refresh-mv-pack-ev-latest`.)

🚨 **THE REAL CAUSE: the arm does not read a cross-collection board at all. It reads
`topshot_pack_reality_top_ev` — a TOP-SHOT-ONLY board of FOUR rows, which has no `collection_id`
column whatsoever.** From `v_rpc_trust_health`:

```sql
WITH packev AS (
  SELECT max(EXTRACT(epoch FROM (now() - snapshotted_at)) / 86400) AS max_stale_days, …
  FROM topshot_pack_reality_top_ev          -- <- Top Shot only, 4 rows, no collection column
)
```

**Measured side by side, same instant:**

| | days |
|---|---|
| what the arm publishes (its Top-Shot-only source) | **0.94** |
| Top Shot's own board staleness | 0.19 |
| **golazos board staleness — invisible to the arm** | **1.35** |

**So `pack_ev_board_max_stale_days` is structurally incapable of reporting staleness for golazos,
All Day, Pinnacle or Candy.** Its name carries no collection qualifier and its `catches` text says
*"stale pack-EV board"*, so it reads as covering every board; it covers one. **A guard silent by
construction about the population its name claims** — the same class as the four guards corrected on
2026-08-17, and the reason golazos could sit 31 h stale with the board green.

⚠ **Fixing the pipeline would NOT fix this.** They are independent defects: a fresh golazos feed
makes the board current again and leaves the arm exactly as blind to the next collection that stops.

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
2026-08-17 06:37Z onward — that alone probably names the cause; (2) ~~read `pack_ev_latest`~~ — DONE, see above: the arm reads a Top-Shot-only source, so widen it to a per-collection max (or add a sibling arm per collection); (3) only then
decide between fixing the function and fixing the arm. **They are separate defects — fixing the
function would make the board fresh again and leave the arm just as blind to the next one.**
