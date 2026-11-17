# Handoff — `topshot-pack-opens-history-backfill` wedged on a persistently-transient spork range (2026-08-07)

---

## ⛔ RESOLVED-BY-MEASUREMENT (Claude Code, 2026-08-07, Trevor's Windows box) — **DO NOT SHIP OPTION A OR OPTION B**

The handoff below could not test its own premise ("Flow REST / spork egress is proxy-blocked here").
That test has now been run from a spork-reachable environment. **Both fix options are refuted, and
the manual-unwedge SQL would cause data loss for no benefit.** Do not implement them.

**What was measured.** A probe replicating `eventsFetch()` byte-for-byte (same URL shape, 3 tries,
15s `AbortSignal.timeout`, same backoff), plus a one-25-block probe at the top of every historical
spork band:

| spork band (`SPORK_MAX_HEIGHTS`) | result |
|---|---|
| 27,341,470 – 31,735,954 | **522** (~19.6s) |
| 31,735,955 – 35,858,810 | **522** |
| 35,858,811 – 40,171,633 | **522** |
| 40,171,634 – 44,950,206 | **522** |
| 44,950,207 – 47,169,686 | **522** |
| 47,169,687 – 55,114,466 | **522** |
| **55,114,467 – 65,264,618** ← contains the wedged range | **522** |
| 65,264,619 – 85,981,134 | 200 (9.5s) |
| 85,981,135 – 88,226,266 | 200 (246ms) |
| 88,226,267 – 130,290,658 | 200 (160ms) |
| 130,290,659 – 137,390,145 | 200 (235ms) |

A clean cut: **every spork band at or below 65,264,618 is dead; every band above it is healthy.**
`522` is Cloudflare *"connection timed out to origin"* — the historical spork access nodes behind
`spork-proxy` are not answering, which is an **upstream/infrastructure outage, not a code defect**.

**Positive control (this is why the result is trustworthy).** An all-fail probe proves nothing on its
own. Verified separately from the same box: `google.com/generate_204` → 204; `spork-proxy` root →
`{"ok":true,"worker":"spork-proxy"}` in **72ms**; `rest-mainnet.onflow.org` → 200; and the four
newest spork bands → 200. So the box, the network, and the worker are all fine — only the old spork
origins time out.

**Why Option A (adaptive sub-chunking) is refuted.** Its premise was that smaller windows get past a
per-query timeout. Measured on the exact wedged range: **250, 125, 50, 25, and 10-block windows all
fail identically** (`status 0`, ~46s = 3×15s). The origin never answers, so window size is irrelevant.
Shipping A would add cursor-adjacent complexity for provably zero benefit.

**Why Option B / the manual-unwedge SQL is actively harmful.** The handoff's own caveat is the
operative one: *"Only durable if the failure is range-specific … if the whole spork
[55114467, 65264618] is down it will re-wedge one chunk lower within ~15 min."* That precondition is
now **measured false** — the whole band is down. Skipping would permanently lose ~250 blocks of real
2022-era pack-open provenance **and** re-wedge on the next chunk within one tick. Worst of both.

**The cursor hold is CORRECT — there is no bug to fix here.** Refusing to advance past unscanned
blocks while upstream is unreachable is the 2026-08-01 design working exactly as intended. The only
genuine defect is one of *honesty*: it pages as `cursor_stalled`, which reads as a pipeline bug, when
the truth is "upstream spork infrastructure is down". Blast radius is exactly one pipeline —
`topshot-pack-opens-history-backfill` (68 runs / 0 ok / 24h); no other pipeline shows spork-class
errors, and the concurrent `topshot-badge-catalog` 429 is unrelated (Top Shot GraphQL rate limit).

**⚠ OPERATOR DECISION (Trevor) — the real question is not which fix to ship, but whether the old
spork nodes are ever coming back.** Historical spork access nodes do get decommissioned. If bands
≤65,264,618 are permanently gone, then the entire sub-65M leg of this backfill is *unreachable by
construction* and the pipeline should be floored at 65,264,619 (or retired) rather than retrying
every 15 min forever. If it is a transient outage, the correct action is to do **nothing** — the
cursor hold already protects the data and it will resume on its own. Until that is known, leaving it
held-and-noisy is strictly safer than skipping data.

**Recheck command** (re-run any time to see if the old sporks came back):
`node scripts/probe-spork-bands.mjs` — added alongside this correction.

---

## Original diagnosis (2026-08-07, Cowork) — accurate as far as it could be tested, premise now superseded above

**Why a handoff and not a ship:** the fix touches a spork-routed Deno edge function
(`supabase/functions/ingest-topshot-pack-opens-history/index.ts`) and cannot be verified from the
cloud sandbox — Flow REST / spork egress is proxy-blocked here, so there is no way to reproduce the
failing range or prove a fix end-to-end. This is cursor/ingest logic where a wrong change causes
silent data loss, so it needs an operator with spork-reachable testing. Diagnosis below is complete;
pick option A (safe, no data loss) or B (operator decision).

## Symptom (sentinel alert)
`topshot_pack_opens_history_backfill · cursor_stalled — Cursor updated 15h+ ago at block 61808846`.

## Root cause (fully diagnosed against live `pipeline_runs`)
The backfill walks DOWN toward `SPORK_FLOOR` (27,341,470), scanning each window **descending** and
checkpointing `scannedFloor = hi + 1` so partial progress survives a flaky upstream. Since ~2026-08-06
22:11 UTC it has been hard-wedged: the **leading** 250-block chunk of the current window,
`[61808596, 61808845]`, fails **every run** with `events 61808596-61808845 status 0`
(`status 0` = the `fetch` threw — timeout/connection reset, after 3 tries @ 15s each).

Because the *first* (topmost) chunk fails, `scanOpens` returns `scannedFloor = hi + 1 = 61808846`,
i.e. equal to `cur`, so `progressed = after < cur` is false and the cursor never advances. The run
logs `ok=false` (correct — nothing moved) and pages. 67 wedged runs / 16.4h continuous as of
2026-08-07 14:26 UTC; before that it was making normal interleaved progress, so the range itself is
genuinely not recovering (it is NOT the whole spork — other spork-routed ranges succeeded).

## The code gap
`skipped_permanent` only triggers on a **non-transient** error (`(!!err || !!rerr) && !anyTransient`,
line ~343). A range that fails *transiently* (`status 0`) forever has **no escape hatch** — the
descending-checkpoint design is monotonic under a *flaky* upstream but wedges permanently against a
*consistently dead* leading chunk. `status 0` is classified transient (`isTransient`, line 127-129),
which is right for genuine flakiness but wrong for a range that is 100%-dead.

## Fix options

### Option A — adaptive sub-chunking on a transient LEADING-chunk failure (safe; NO data skipped)
In `scanOpens`, when a chunk fails transiently, retry it as smaller sub-windows (e.g. halve
`EVENT_RANGE` down to a floor of ~10-25 blocks) before giving up. If the cause is query heaviness /
per-query timeout on that spork, smaller windows get past it and the walk resumes. If even the
smallest window fails, behaviour is identical to today (hold the cursor — no data loss). Strictly
safe: it never advances past unscanned blocks. **Must be dry-run in `?mode=probe` against a
spork-reachable env for that height before deploy.**

### Option B — bounded permanent-skip after N consecutive identical-range transient failures (operator decision — SKIPS DATA)
After M consecutive runs where `scannedFloor == cur` on the same leading chunk, treat that chunk as
permanently unreachable: advance the cursor past it (`after = lo - 1`) and record the skipped range
(a new `pipeline_runs.extra.skipped_range` + optionally a `backfill_skipped_ranges` row) for later
re-walk. **This LOSES those ~250 blocks of 2022-era TS pack-opens provenance** (this window is below
the 61,930,346 Dapper-registry bulk-load line, so it is *real discovery*, not re-verification). It
unwedges the 34M-block journey at the cost of one documented gap. This is a data-completeness
tradeoff — Trevor's call, not autonomous.

## Immediate manual unwedge (if desired now, before any code change)
```sql
-- Steps the cursor past the dead 250-block leading chunk. SKIPS [61808596, 61808845].
-- Only durable if the failure is range-specific (it is, per the diagnosis above) — if the whole
-- spork [55114467, 65264618] is down it will re-wedge one chunk lower within ~15 min.
UPDATE event_cursor SET last_processed_block = 61808595, updated_at = now()
WHERE id = 'topshot_pack_opens_history_backfill';
```
Same data-loss caveat as Option B. Verify the next run's `progress_blocks > 0` afterward.

## Not a defect (verified, do not "fix")
The descending-checkpoint + hold-on-transient design is correct and load-bearing (it is the 2026-08-01
fix that stopped the fn discarding 100-query windows). The wedge is the *missing escape hatch* for a
permanently-dead range, not the checkpoint logic.
