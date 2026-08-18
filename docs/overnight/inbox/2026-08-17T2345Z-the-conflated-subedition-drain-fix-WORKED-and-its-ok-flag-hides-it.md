# The 2026-08-15 conflated-subedition reorder FIXED the drain — and its `ok` flag makes the recovery invisible

> ## ✅ SHIPPED 2026-08-18 — option 2, `ok` is reachable again
>
> A step Postgres cancels at `statement_timeout` (SQLSTATE **57014** / the
> `canceling statement due to statement timeout` text) no longer populates an
> `*_error` slot. It is recorded as `extra.truncated_steps` with the message
> under `<step>_truncated` — the same contract `skipped_steps` already carried
> (visible, never silent, never red). **The `ok` conjunction is UNCHANGED**, so
> the false-positive risk this filing warned about does not arise: every other
> error still reds the run.
>
> ⚠ A **gateway** timeout is NOT reclassified — same ~2 minutes, different
> meaning — and that discriminator is pinned by a test.
>
> Pinned by five cases in `__tests__/api-admin-drain-conflated-subeditions.test.ts`,
> all five verified red against the pre-fix route, including a source-derived
> sweep so a tenth step cannot opt out of the classification.
>
> ⚠ The `conflated_editions_remaining` 961 → 974 question at the bottom is
> **still open** — it was two points then and nothing here re-measured it.

Filed 2026-08-17 16:45 PT / 23:45Z (Claude Code, interactive). **This corrects my own framing from two hours
earlier**, where the watchlist audit listed `drain-conflated-subeditions` among "5 unwatched pipelines with
zero successes." It has zero *successes*. It does not have zero *success*.

## What the route already knew, and what I nearly re-filed

`app/api/admin/drain-conflated-subeditions/route.ts` carries a precise 2026-08-15 diagnosis (deep-audit R7):
three steps (`seed_miskeyed`, `seed_recent`, `seed_knot_occupants`) sit at ~120,3xx ms — **a `statement_timeout=120s`
CEILING in each function's own proconfig, not work** — they roll back producing nothing, and because they ran
FIRST they starved the steps that do the draining. Named consequence: `resolve_topshot_subedition_collision_knots`
*"has not executed ONCE since 2026-07-31 20:33:53Z — 76 resolutions ever."*

The fix applied was **"DRAIN before SEED, plus a budget guard."**

⚠ **I was one step from filing "8 consecutive days of failure, `seed_recent` wedged at the 120 s timeout" —
which is true about the step and wrong about the pipeline.** Grepping the route's own comments before
diagnosing is the standing rule; this is its third save in one session.

## The fix WORKED, and here is the independent confirmation nobody had collected

| measure | at the 2026-08-15 diagnosis | now (2026-08-17 23:4xZ) |
|---|---|---|
| `topshot_collision_knot_resolutions` total | **76** | **272** |
| resolved in the last 3 days | **0** | **196** |
| newest resolution | 2026-07-31 20:33Z | **2026-08-17 20:32Z (today's run)** |
| `rows_written` per run | **0** (08-10 → 08-15) | **992 / 1,007** (08-16, 08-17) |
| knots resolved per run | 0 | **98** |

The transition is exactly at the fix: every run 08-10 → 08-15 wrote **0** rows and logged *"started (no
completion recorded — killed at maxDuration?)"*; every run since writes ~1,000 and resolves 98 knots. **The
knot resolver went from dead-for-3-weeks to ~65/day.**

## The defect that remains: `ok` cannot be true

Line ~420:

```ts
const ok = !out.fatal && !out.seed_error && !out.seed_miskeyed_error && !out.seed_recent_error
        && !out.seed_knot_error && !out.catalog_error && !out.split_error && !out.realign_error
        && !out.guard_error && !out.knot_resolve_error
```

`ok` is an AND over *every* step's error slot. The seed steps are **known and expected** to be cut off — that
is the whole point of running them last behind a budget guard — so `seed_recent_error` is set on essentially
every run, and **`ok` is therefore pinned false forever.**

⚠ **A pipeline that cannot report success is indistinguishable from a broken one**, which is this repo's
standing rule about permanently-red instruments — and here it hid a *successful repair*. It also means the
run is invisible to any success-based check, and the `rows_written > 0` makes it invisible to the
`Pipeline Success Coverage` arm's third term as well. **Two independent detectors, both blind, on a pipeline
that is actually healthy.**

## What NOT to do, and the options

⛔ **Do not simply drop `seed_recent_error` from the `ok` conjunction.** That trades a false negative for a
false positive: a genuine seed failure would then report success, on the pipeline that keys TopShot editions —
the thing every edition-keyed FMV derives from.

The honest shapes, in preference order:

1. **Report two claims instead of one.** The drain steps succeeding and the seed steps completing are
   different facts. `ok` should reflect the drain (the work this tick was for); seed truncation belongs in
   `extra` as a first-class `seeds_truncated: true`, not as an error that poisons the run.
2. **Distinguish "cut off by design" from "failed."** A step stopped by the budget guard is not an error at
   all; only an unexpected error should populate an `*_error` slot. This is the smaller change and probably
   the right one.
3. **Leave it and suppress** — worst option: it keeps a healthy pipeline permanently red, which is exactly
   what trains an operator to skim.

⚠ **Unresolved, and stated rather than guessed: `conflated_editions_remaining` read 961 → 974 across the two
recorded runs.** That is **two points, not a distribution** — it may be growth, arrival noise, or the seed
steps genuinely not keeping up. `topshot_conflated_editions` is 974 now, which matches the pipeline's own
count. **Re-derive over a week before concluding the drain is losing ground** — the knot half is clearly
winning, and the two queues are different.
