# ⛔ RETRACTED — the mechanism in this filing was backwards, and its fix would have lost data

⚠ **The filename is wrong too.** There was no "unservable window." Refuted by `34a42c11`
(`docs/overnight/inbox/2026-08-23T1609Z-...`), verified independently here 2026-08-23 against
`supabase/functions/ingest-allday-pack-opens/index.ts` and against live `pipeline_runs`.
**Do not implement the `skipped_permanent` escalation this file proposed.**

## What I got wrong

I claimed the scan "walks a ~25,000-block span in 250-block chunks and dies on **the final chunk**,"
and proposed advancing the cursor past that chunk.

`index.ts:515` passes `"desc"` to `scanOpens(start, end, "desc")`, with `end = cur - 1` and
`start = max(floor, end - maxBlocks + 1)`. The walk **descends from `end`**. So
`events 84699998-84700247` is `[end-249, end]` — **query #1**, the FIRST chunk, not the last.

Zero blocks were ever scanned. Advancing the cursor past that chunk would have **permanently skipped
real AllDay pack opens** on a backfill that never revisits them. I proposed a data-loss bug.

**The disproof was inside the telemetry I quoted in this very file and read past:**

- `queries: 1` — one events query, ever. A walk that had reached its final chunk would show ~100.
- `scanned_floor: 84700248` = `end + 1` — precisely the `hi + 1` the desc branch returns when the
  *first* chunk fails. I noted the arithmetic and drew the opposite conclusion from it.

I wrote the caveat "the chunking interpretation is arithmetic on the reported numbers, not a reading
of the source." The caveat was correct and it was exactly where the error was. **A labelled inference
is not a safe inference — it is a flagged one, and this one should have been resolved by reading the
40 lines of source sitting on the mount before proposing a fix.**

## What the cause actually is — already measured, already fixed, unshipped

`status 0` is **our own abort**, not the node refusing. `index.ts:145-170` documents it: the spork
caller aborts at 15 s while `workers/spork-proxy` allows itself `REQUEST_TIMEOUT_MS = 25_000`, so the
caller quits 10 s before the worker may answer. The comment even names the discriminator —
*"a worker-side timeout would read 504, which is what proves which side gives up."* Measured
**2026-08-21**, two days before I filed.

That also explains the 46.7–46.9 s cluster I flagged but could not attribute: **3 × 15 s + ~1.2 s
backoff ≈ 46.2 s.** Our own abort multiplied by the retry count. I read a fixed timeout correctly and
attributed it to the wrong side of the connection.

`transient: true` is therefore **correct**, not a misclassification — the node was never asked long
enough to refuse. My "a window that has failed for three days is still classified as a temporary blip"
had the causality inverted.

The fix (`28 s × 2 tries = 56.4 s`, fitting under pg_net's 90 s) is pinned by
`__tests__/edge-allday-pack-opens-timeout-budget.test.ts` and is unshipped only because the function
needs the gate-key rotation window. **Operator scheduling, not a code change.**

## The lane was never wedged

Live `pipeline_runs`, after this filing was written:

| started (UTC) | window | queries | progress_blocks | ok |
|---|---|---|---|---|
| 08-23 02:16 | 84675248 → 84700247 | **100** | **6,493** | ✅ |
| 08-23 03:16 | 84668755 → 84693754 | 100 | 4,749 | ✅ |
| 08-23 05:56 | 84664006 → 84689005 | 100 | **25,000** | ✅ |
| 08-23 09:26 | 84639006 → 84664005 | 1 | 0 | ❌ `status 0` @ 46.7 s |
| 08-23 11:36 | 84639006 → 84664005 | 1 | 0 | ❌ `status 0` @ 46.7 s |
| 08-23 14:06 | 84639006 → 84664005 | 4 | 750 | ✅ |

The window I called permanently stuck — `84675248 → 84700247` — was scanned successfully **eleven
minutes after I filed**, 100 queries, 6,493 blocks. The cursor has since descended to 84664005,
including one clean 25,000-block sweep. A first-chunk abort **costs a tick, it does not stall the
walk**; the checkpointing from `e67606f5` is doing its job. The 13 h silence was real when observed
and self-cleared.

Note also that the failing chunk moved with the window: `84663756-84664005` is `[end-249, end]` for
`end = 84664005`. The failing chunk is always at the **top** of the window. That is the desc walk,
stated by the data itself.

## Second correction: "byte-identical" was wrong

I wrote that every failing run carried a byte-identical `extra`. Two distinct failures are being
conflated, and their durations are **20× apart**:

- `status 0` at **~46.7 s** — our own abort (above).
- `status 503` at **2.2 s / 3.8 s** — the upstream refusing, fast.

Both numbers were in my own table. I let a shared `scan_err` prefix stand in for sameness.

## What survives

- **The twin-job positive control.** `cron.job` 20 (`forward`, 129/126 ok) and 55 (`backfill`, 38/7)
  call the same edge function with the same `key` and `mode` params, so the gate key, the deploy,
  the host's DNS and pg_cron dispatch are all proven good without reading a secret. Auth was
  correctly eliminated. Not disputed.
- **The `cursor_read … Timed out acquiring connection from connection pool` separation** — a distinct
  DB-saturation failure (62.0 s, 63.6 s, and again at 03:36 and 13:18 on 08-23), not the block-window
  issue. Not disputed.
- **The NULL-status attribution point.** 128 NULL/timeout in 3 h against job 55's 6 dispatches/h means
  this lane accounts for at most ~18; the bulk is elsewhere. Consistent with the refutation, since our
  own aborts are exactly what produce those NULLs.

## One open observation, deliberately NOT a claim

`rips_written: 0` on every run in the table above, including the clean 25,000-block sweep. That may
simply mean this block range contains no AllDay pack opens. I am not asserting anything about it —
recording it so someone with the source in hand can confirm or dismiss it.
