# An upstream HTTP error defeats the cursor hold in 7 of 8 block-scan indexers

> ## ⚠ AMENDED 2026-08-21 (PT ~00:35, same day) — THE TITLE UNDERSTATES THIS BY MORE THAN HALF. RESOLVED IN PART.
>
> **The real population is 17 routes, not 8, and EVERY ONE OF THEM had the
> defect.** "7 of 8" was measured against the wrong denominator: I derived the
> family from routes containing `firstFailedChunkStart`, which is the symbol for
> the cursor-HOLD, not for the event FETCH. Ten more routes define the same
> `fetchEventRange` and carry the same swallow; none contains that symbol,
> because none of them implements a hold at all. **I measured a proxy and
> reported it as the property — the fifth time this pass.** The guard that was
> supposed to protect this family had the same blind spot, by the same
> derivation, which is why the swallow survived in them.
>
> Corrected census, `grep -rl 'async function fetchEventRange' app/api`, 17 files:
>
> | group | n | state |
> |---|---|---|
> | block-scan indexers (allday/golazos/topshot/ufc × listings+sales) | 7 | ✅ **FIXED + tested 2026-08-21** |
> | offers indexers (allday/golazos/topshot) | 3 | ✅ **FIXED + tested 2026-08-21** |
> | `pinnacle-{listings,sales}-indexer` | 2 | ❌ open — fix is NOT the one-liner |
> | `*-sales-history-backfill` (allday/golazos/pinnacle/topshot-flowty/ufc) | 5 | ❌ open — fix is NOT the one-liner |
>
> ### Shipped (10 routes)
>
> `fetchEventRange` now THROWS on a non-2xx. For the 7 block-scan indexers the
> chunk `catch` then records `firstFailedChunkStart` and caps the cursor as it
> always intended to; for the 3 offers indexers the whole scan already sits in
> one `try/catch` whose catch fires BEFORE the cursor update, so the tick aborts
> with the cursor untouched and `ok=false` logged.
>
> Covered by `__tests__/indexer-http-error-holds-cursor.test.ts` (table-driven
> over all 10, no-slack membership assertion) — **every one of the 10 verified by
> mutation: reinstating the swallow reddens exactly that route's case.**
>
> ### ⚠ TWO EXISTING TESTS WERE PINNING THE DEFECT AS CORRECT
>
> This is the part worth keeping. The bug was not untested; it was **asserted**:
>
> - `api-allday-listings-indexer-deep` — *"…survives a 500 event fetch"*, ending
>   `// The 500 leg did not poison the run — cursor still advanced.` with
>   `expect(log?.p_cursor_after).toBe("1250")`.
> - `api-allday-offers-indexer-deep` — *"an OfferAvailable events HTTP error
>   degrades that range to empty and still advances the cursor"*, asserting
>   `{ ok: true, offersSeen: 0, cursorAfter: "1250" }`.
>
> Both called permanent data loss a graceful degrade, **in the test title**. Both
> are now INVERTED in place per CLAUDE.md (never deleted — the assertion is what
> held the defect there). The generalisable tell: a test title containing
> *"survives"*, *"degrades to"* or *"still advances"* is a claim that a failure
> was ABSORBED, and absorbing a failed read is the honesty canon's core defect.
> **Grep test TITLES for that shape; it is where this class hides.**
>
> ### Still open, and why they are not one-line fixes (measured, not assumed)
>
> - **`pinnacle-listings-indexer`** — swallows, AND has no hold: the chunk catch
>   neither breaks nor caps, and the cursor is set to `targetHeight`
>   unconditionally after the loop. Throwing alone changes nothing.
> - **`pinnacle-sales-indexer`** — swallows, AND advances the cursor PER CHUNK
>   inside a catch that does not `break`, so a later chunk leapfrogs a failed one
>   **even on a thrown error**. Also unaffected by the throw alone.
> - **The 5 `*-sales-history-backfill` crons** — swallow non-2xx *and* thrown
>   errors into `{blocks: [], belowFloor: false}`, then advance the backward
>   cursor with `const newLow = belowFloor ? start : start` (both branches
>   identical — a no-op ternary) unconditionally. These walk HISTORY, so a
>   skipped range is never revisited by anything. They also have a LEGITIMATE
>   non-throwing case (a 404 `"is less than"` below the node's block floor), so
>   the fix must distinguish it rather than throw on every non-2xx.
>
> All seven are held by a **shrink-only ratchet** in
> `__tests__/indexer-cursor-hold-on-partial-scan-guard.test.ts` (`KNOWN_SWALLOWERS`,
> asserted by exact equality): fixing one reddens the guard until it is delisted,
> and a new route cannot join. Mutation-verified in three directions — a fixed
> route regressing, a listed route being fixed without delisting, and a brand-new
> route landing with the swallow.
>
> **Trevor's call:** the Pinnacle pair sits on a live Pinnacle ingest path and
> needs the full partial-scan pattern, not a one-liner; the backfills need the
> below-floor case preserved. Neither was shipped blind.


**Filed 2026-08-21 (PT 2026-08-21 ~07:20), Claude Code interactive. PROVEN by
execution, not by reading. NOT fixed — the fix touches 7 production ingest routes
with a permanent-data-loss failure mode, which is Trevor's call.**

---

## The defect

The block-scan indexers walk Flow in 250-height chunks and persist a cursor. Each
chunk is wrapped in `try/catch`; on failure `firstFailedChunkStart` is recorded and
the final cursor is capped at `firstFailedChunkStart - 1`, so the failed range is
re-scanned next tick. `__tests__/indexer-cursor-hold-on-partial-scan-guard.test.ts`
exists specifically to protect this, and its header states the stakes exactly:

> *"If one chunk's fetch fails and the cursor still advances to `targetHeight`,
> every sale in the failed range is skipped FOREVER — the next tick starts after
> it. Nothing errors, nothing retries, and the rows simply never exist."*

⚠ **But the chunk `catch` only sees THROWN errors.** The event fetch is:

```js
async function fetchEventRange(type, start, end) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) {
    console.log(`[…] events ${start}-${end} … HTTP ${res.status}: …`)
    return []            // ← swallowed. Not a throw.
  }
  …
}
```

An HTTP 4xx/5xx from the Flow REST node therefore returns `[]`, the chunk reads as
**genuinely empty**, `firstFailedChunkStart` stays `null`, and the cursor advances
past a range that was never read. **The blocks are never revisited.**

## Proof — executed, not inferred

Added a temporary probe to `api-allday-sales-indexer-deep.test.ts`: same three-chunk
fixture the existing partial-scan test uses (sealed 1500, cursor 750 → chunks
751-1000, 1001-1250, 1251-1500), but chunk `start_height=1001` answers **HTTP 500**
instead of throwing.

```
AssertionError: expected { last_processed_block: 1500 } to match { last_processed_block: 1000 }
-   "last_processed_block": 1000,
+   "last_processed_block": 1500,
```

**The cursor advanced to 1500**, skipping 1001-1250 permanently. The probe was
removed; the file is unchanged on disk.

⚠ **The contrast is the whole point.** The existing test in that same file uses a
THROWN `ECONNRESET` on the same chunks and correctly asserts the cursor holds at
1000. Both are "the chunk failed". Only one reaches the `catch`.

## Blast radius — 7 of 8, verified mechanically

Discovered the family from source (`grep -rl firstFailedChunkStart app/api`), then
checked, per route, whether the helper containing the `!res.ok → return []` swallow
is the one the chunk loop calls:

| route | swallowing helper called in the chunk loop |
|---|---|
| `allday-sales-indexer` | `fetchEventRange` |
| `allday-listings-indexer` | `fetchEventRange` |
| `golazos-sales-indexer` | `fetchEventRange` |
| `golazos-listings-indexer` | `fetchEventRange` |
| `topshot-listings-indexer` | `fetchEventRange` |
| `ufc-sales-indexer` | `fetchEventRange` |
| `ufc-listings-indexer` | `fetchEventRange` |
| **`sales-indexer`** | **none — immune** |

`sales-indexer` is the only one that reaches Flow through **fcl** rather than REST,
and fcl throws on an error response, so its `catch` sees every failure. That is why
it is the exception, not because anyone hardened it.

## Why every existing test misses it

Not an oversight in any one test — a **shared blind spot in the fixtures**. Every
cursor-hold test in this family simulates failure by THROWING (`ECONNRESET`), which
is the path that works. None returns a non-2xx response. The source guard is blind
too, and by construction: it asserts the source *contains* a cap expression, which
it does — the expression is correct and simply never reached.

⚠ **This is the "coverage is only real against what the guard reads" shape**, with
an extra turn: here the guard, the behavioural tests, AND the code are each
individually right, and the defect lives in the gap between "a chunk failed" and
"a chunk threw".

## Frequency — UNMEASURED, and I could not establish it

⚠ **State this honestly rather than implying it is happening constantly.** The
mechanism is established; the rate is not.

- Vercel runtime logs for `allday-sales-indexer events` over a 3h production window:
  **no hits**. A 24h query timed out before returning.
- 3h is a weak sample and **absence of log lines is not absence of the event**.
- There is no direct instrument: a silently-skipped chunk produces a clean
  `ok: true` run with no `partial_scan` flag, which is exactly why it is dangerous.

So: **do not read this as "we are losing sales right now."** Read it as "the
protection this family was given does not cover one of the two ways its upstream
fails, and if that way occurs the loss is silent and permanent."

## The fix, and why I did not ship it

One line per route — make the swallow a throw so it reaches the existing `catch`:

```js
if (!res.ok) {
  const body = (await res.text()).slice(0, 200)
  throw new Error(`events ${start}-${end} HTTP ${res.status}: ${body}`)
}
```

The `catch` already logs and sets `firstFailedChunkStart`, so nothing else changes —
the cursor hold, the `partial_scan` extra and the re-scan all start working for HTTP
failures automatically.

**Not shipped, deliberately.** It is a behaviour change to **7 production ingest
routes** whose failure mode is permanent data loss, it is the exact category
CLAUDE.md places off-limits for autonomous shipping (*"FMV/ingest/pricing … route
logic"*), and the cursor-hold guard's own header records a standing decision not to
refactor production ingest in this area. ⚠ It also has a real cost worth weighing
before acting: routes that currently ride out a transient 500 by treating the chunk
as empty would begin holding the cursor and re-scanning, which is **correct** but
will make partial scans visibly more frequent.

**Recommended order if it goes ahead:** one route first (`allday-sales-indexer`,
which already has the richest deep-test harness), with a behavioural test asserting
the HTTP path now holds — the probe above becomes that test, inverted from proof to
guard — then the remaining six, then widen
`indexer-cursor-hold-on-partial-scan-guard` to assert the fetch helper does not
swallow, so the eighth indexer cannot land with it.

---

## Also worth knowing: that guard's header is now stale

It says *"only 2 test files reference it — neither of them covering
`allday-sales-indexer` or `sales-indexer`."* Both are covered now:
`api-allday-sales-indexer-deep.test.ts` gained a three-chunk two-failure cursor-hold
case, and `api-sales-indexer-deep.test.ts` gained five (2026-08-20). ⚠ I nearly
duplicated the All Day one by trusting that sentence — the same
stale-prose-as-work-queue trap that has now caught five items in this workstream.
