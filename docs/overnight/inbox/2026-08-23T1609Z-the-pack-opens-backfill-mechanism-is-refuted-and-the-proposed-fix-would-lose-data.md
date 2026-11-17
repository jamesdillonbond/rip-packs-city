# The `allday-pack-opens-backfill` mechanism is REFUTED — and the proposed fix would lose data

**Filed 2026-08-23 09:09 PT (16:09Z), Claude Code interactive, from Trevor's Windows box.**

Corrects a Cowork filing of **2026-08-23 ~02:15Z** that added a mechanism to
[`2026-08-23T0200Z-allday-pack-opens-backfill-silent-while-pg-cron-reports-141-successes.md`](2026-08-23T0200Z-allday-pack-opens-backfill-silent-while-pg-cron-reports-141-successes.md).

⛔ **Do NOT implement that filing's suggested fix.** It proposes escalating a repeatedly-failing
window to `skipped_permanent` and advancing the cursor past it. The window is not unservable —
**we abort it ourselves** — so that change would permanently skip real blocks of AllDay pack
opens, which is silent data loss on a backfill that cannot revisit them.

This is a textbook instance of the CLAUDE.md rule *"a filed FINDING is a hypothesis — re-derive
which subsystem it measured before acting."* The Cowork pass was right that the lane is sick and
right to eliminate the auth branch with its jobid-20 twin. Its **mechanism** is backwards.

---

## What the filing claimed, and what the source says

> "the scan walks a ~25,000-block span in 250-block chunks and dies on **the final chunk**"

**Backwards.** `scanOpens` takes a `ScanDir`, and the backfill passes `"desc"`
([index.ts:515](../../../supabase/functions/ingest-allday-pack-opens/index.ts#L515)). The desc
branch starts at `hi = end` and walks **down**:

```ts
if (dir === "desc") {
  let hi = end
  while (hi >= start) {
    const lo = Math.max(start, hi - EVENT_RANGE + 1)
    queries++
    const res = await eventsFetch(OPENED, lo, hi)
    if (!res.ok) return { …, scannedFloor: hi + 1, scannedCeil: end }
```

So for the quoted failure `start 84675248 · end 84700247`, the chunk `84699998-84700247` is
`[end - 249, end]` — **query #1**, not the last of ~100. The filing's own quoted telemetry proves
it and was read past:

- **`queries: 1`** — exactly one events query was ever issued.
- **`scanned_floor: 84700248` = `end + 1`** — the `hi + 1` returned on a first-chunk failure. Zero
  blocks confirmed scanned.

The tick does no work at all, rather than 99 chunks of work and then a stumble.

## The cause is already measured, already written down, and already has a prepared fix

`status 0` means **`fetch` threw**, and here it is our own abort. From
[index.ts:155-160](../../../supabase/functions/ingest-allday-pack-opens/index.ts#L155), measured
**2026-08-21**:

> the spork caller aborts at 15 s while `workers/spork-proxy` allows ITSELF
> `REQUEST_TIMEOUT_MS = 25_000`, so the caller quits 10 s before the worker may answer.
> `status 0` on 40 of 42 backfill runs / 72h is that abort — a worker-side timeout would read
> `504`, which is what proves which side gives up.

Confirmed independently here: `workers/spork-proxy/index.ts:58` is `REQUEST_TIMEOUT_MS = 25_000`,
against `SPORK_TIMEOUT_MS = 15_000` / `SPORK_TRIES = 3` in the caller.

**This also explains the duration cluster the filing flagged but could not attribute.** It read
46.7–46.9 s as "a fixed internal timeout, not DNS jitter" — correct instinct, and the arithmetic
is `3 × 15 s + 400 ms + 800 ms backoff ≈ 46.2 s` plus overhead. It is our retry loop, timed.

The fix (`28 s × 2 tries = 56.4 s`, which fits pg_net's 90 s and outlasts the worker) is already
pinned by [`__tests__/edge-allday-pack-opens-timeout-budget.test.ts`](../../../__tests__/edge-allday-pack-opens-timeout-budget.test.ts),
so a wrong value reddens CI. It is **not shipped** because this function can only be deployed in
the gate-key rotation window — the standing `_OLD` dual-accept blocker (memory:
`edge-fn-deploy-blocked-by-unset-gate-key`, jobs 20/55/56/83/84/44).

## `transient: true` is CORRECT, not the mis-classification the filing names

The filing reads `transient: true` with `skipped_permanent: false` on a three-day-old window as a
classifier that never escalates. But `isTransient(0)` returning `true` is the right answer: the
access node was never asked long enough to refuse. The `skipped_permanent` path exists for the
**404-pruned-block** case and works; it is simply not this case.

There is also a real permanent-vs-transient hazard in the proposal that the filing does not
address: `after` is derived from `scannedFloor`, and on a first-chunk failure `scannedFloor` is
`end + 1`, i.e. **above** the cursor. `after = Math.min(after, cur)` is what currently holds the
line. Force-advancing past the chunk would hand that clamp a value it was written to reject.

## Two error populations were merged into one

The filing calls every failing run "byte-identical `extra`". Live rows separate cleanly:

| `scan_err` | duration | reading |
|---|---|---|
| `… status 0` | **46.7 s / 46.7 s / 46.9 s** | our own 3 × 15 s abort — the bug above |
| `… status 503` | **2.2 s / 3.8 s** | upstream refusing fast; a different, genuinely external event |

A ~20× duration gap is not one failure mode.

## The lane is NOT wedged, and the cursor IS advancing

This is the part that has moved since the filing was written, and it matters most for triage.
`pipeline_runs`, read 16:05Z today:

| started_at (UTC) | ok | queries | window | `progress_blocks` |
|---|---|---|---|---|
| 08-23 14:06:02 | ✅ | 4 | 84639006–84664005 | 750 |
| 08-23 13:18:54 | ❌ | — | — | `cursor_read … connection pool` |
| 08-23 11:36:02 | ❌ | 1 | 84639006–84664005 | 0 |
| 08-23 09:26:05 | ❌ | 1 | 84639006–84664005 | 0 |
| 08-23 05:56:01 | ✅ | **100** | 84664006–84689005 | **25000** (clean full sweep) |
| 08-23 03:16:03 | ✅ | 100 | 84668755–84693754 | 4749 |
| 08-23 02:16:55 | ✅ | 100 | 84675248–84700247 | 6493 |
| 08-22 13:16:06 | ❌ | — | — | `cursor_read … connection pool` |

The window has descended **84700247 → 84664005** since the filing, including one **clean 25,000-block
sweep with zero errors**. The checkpointing added in `e67606f5` is doing its job: a first-chunk
failure costs a tick, it does not wedge the walk.

⚠ **The filing's "last row 2026-08-22 13:16Z, ~78 ticks with no row" was TRUE WHEN WRITTEN** (the
next row is 02:16:55Z, ~1 h after it was filed) **and it self-cleared.** That is a 13 h gap that
resolved without intervention — which is evidence for the saturation/startup-timeout class, not
for a wedged cursor.

## What actually remains open

1. **The 15 s vs 25 s abort mismatch** — diagnosed, tested, unshipped, blocked on the gate-key
   rotation window. This is the whole fix. **Trevor's call, not a code change anyone can make today.**
2. **Sparse `pipeline_runs` rows** — 8 rows over ~26.7 h against ~160 dispatches. Every terminal
   branch in the handler calls `logRun`, so a missing row means the tick never reached the handler.
   The prior filing already attributes this to `job startup timeout` + NULL-status DNS hangs; note
   that two runs logged **150.7 s and 125.1 s durations**, i.e. the function outlives pg_net's 90 s
   budget and still writes its row — so a killed *response* is not a lost *tick*.
3. **The `cursor_read … Timed out acquiring connection from connection pool` runs** — 3 in the
   window, 62–105 s. Pure DB-saturation class, correctly separated by the filing. Not this bug.

## Method note worth keeping

The filing had `queries: 1` in hand and reasoned past it to a 100-query walk, because it inferred
the scan direction from the word *backfill* rather than reading `scanOpens`'s `dir` argument. The
telemetry was sufficient to refute the story it was used to support. **`queries` and `scanned_floor`
together pin the failing chunk's position exactly — read them before reconstructing the walk.**

Related: [`2026-08-21T1735Z-allday-pack-opens-backfill-throughput-collapsed-1000x.md`](2026-08-21T1735Z-allday-pack-opens-backfill-throughput-collapsed-1000x.md).
