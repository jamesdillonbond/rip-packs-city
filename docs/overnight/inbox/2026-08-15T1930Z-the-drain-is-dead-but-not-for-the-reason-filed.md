# `drain-conflated-subeditions`: the route really is dead, but R7's stated impact is wrong — and the real one is worse

Filed 2026-08-15 ~12:30 PT (19:30Z), Claude Code interactive, from Trevor's Windows box.
Read before acting on register row **R7**.

Nothing here disputes that the route is 100% killed. This is about **what that costs**, because
R7 names a consequence that is not happening and misses the one that is.

---

## TL;DR

| R7 claim | verdict |
|---|---|
| The route is 100% dark-killed, last success 2026-07-31 | ✅ **CONFIRMED** |
| Absent from `pipeline_cadence_watchlist` / nothing watches it | ✅ **CONFIRMED** (no trust arm either) |
| "the conflation guard has been stale by construction ~15 days" | ⛔ **FALSE** — it is 0.0 days stale |
| *(unstated)* the knot drain has stopped dead | ⚠ **THE REAL IMPACT** — 0 resolutions in 14.9 days |
| `duration_ms` 147–176 ms as evidence it dies instantly | ⛔ **not a run length** (already fixed, `398d68ac`) |

---

## Why the guard claim is false

R7 reasons that step 5 (`refresh_topshot_conflated_editions_detector_only`) sits inside the killed
tick, so the conflation guard must be stale. **That function has a second, independent caller:**

```
pg_cron jobid 62  rpc-remap-misattributed-sales   23 */6 * * *   active
  SELECT public.remap_misattributed_topshot_sales();
  SELECT public.refresh_topshot_conflated_editions_detector_only();
```

Four refreshes a day, entirely outside this route. Measured live:

```
max(detected_at) = 2026-08-15 18:23:00Z   days_stale = 0.0   rows = 931
distinct days in the table = 1            -- it is fully rewritten each refresh
```

So step 5 is **redundant for freshness**, and a session that "fixes the stale guard" would be
fixing nothing. This matters beyond the tidiness: `topshot_deals_vs_fmv` excludes
`topshot_conflated_editions` in its `NOT EXISTS`, so if that guard really had been 15 days stale,
the public deals board would be publishing conflated (mis-priced) editions as deals. It is not.

⚠ **The generalisable bit:** R7 inferred staleness from *"the only caller I can see is inside the
dead thing"*. One `cron.job` query falsified it. **A function's callers are a measurable fact, not
an inference from the file you happen to be reading** — the same shape as the sentinel check that
was nearly deleted as "superseded" before someone read what it actually keyed on.

## What is actually broken: step 6, the knots

Step 6 (`resolve_topshot_subedition_collision_knots`) is the LAST of ten marks, so a tick killed
anywhere earlier never reaches it. Every move it makes is logged, which makes this decisive:

```
select count(*), max(resolved_at) from topshot_collision_knot_resolutions;
  total_resolutions  = 76        -- ever
  last_resolution    = 2026-07-31 20:33:53Z
  days_since         = 14.9
```

**The last knot resolved in the exact minute of the last successful run, and nothing has resolved
since.** Knots are the two-moments-transposed-onto-each-other's-(edition,serial) class that
split (step 4) and realign (step 4b) **structurally cannot** fix — each is blocked until the other
moves. The route's own header measured arrivals at **+8.3/night, monotonic**, and records that the
queue was **divergent**, not merely slow, which is why `p_limit` went 5 → 100 on 07-31.

14.9 days × ~8.3/night ≈ **~124 knots accrued with zero drained.**

⚠ One caveat on the throughput assumption, worth knowing before raising anything: the last
successful run resolved **10**, not 100, against a `p_limit` of 100. So on that night candidate
*availability* bound the step, not the cap — do not read "100/run" as the recovery rate when
sizing how long a drain will take.

## Do not guess which step overruns — it self-reports on the next tick

`80e99d4d` (2026-08-15 09:06 PT) made `mark()` persist progressively, so a killed tick now leaves
`extra.last_step` and partial `extra.step_ms` on the marker row. The three retained runs
(08-12/13/14) all predate it and show `last_step: null`, which is why nothing is diagnosable yet.

**The 20:30Z tick is the first that will name the offending step.** The route's own instruction —
"if a tick nears the ceiling, read `step_ms` and bound THAT step" — becomes actionable then, and
was self-defeating before. Deliberately not guessing here.

## Suggested action (NOT taken — needs the 20:30Z data, and the file is hot)

1. Read `extra.last_step` + `extra.step_ms` from the 2026-08-15 20:30Z run.
2. Bound that step's `p_limit`, or give it its own row + COMMIT as R7 proposes.
3. ⚠ **Do not raise `maxDuration` again.** It went 300 → 600 and the kill rate stayed 100%. 800 is
   the Pro hard cap and breaching it ERRORs the deploy invisibly.
4. Consider an internal deadline so a tick that runs out of budget **finishes its own row**
   (`partial: true`, `stopped_after: <step>`) instead of being killed dark — every step is
   idempotent and cursor-driven, so stopping early is free. ⚠ Keep such a run `ok: false`: it did
   not do its job, and flipping it green would trade a dark failure for a quiet one.
5. Nothing watches this route at all — no `pipeline_cadence_watchlist` row, no trust arm on either
   the 931-row conflated backlog or the knot queue. A cadence arm would NOT have caught this
   (the cron fires perfectly; the work inside dies), so any arm must key on
   `topshot_collision_knot_resolutions` age or on `ok`.

⚠ The route file was last touched 2.5 h before this note by a concurrent session. Coordinate.
