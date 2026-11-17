# 2 in 7 IPFS transfers die MID-BODY after a successful headers read — and the obvious cause is refuted by the same seven rows

**Filed 2026-09-03 ~07:00 PT (14:00Z) by Claude Code. NOTHING SHIPPED for this.** It is the first thing
the `streamed` completion line found, on its first day.

## 0. How this became visible at all

Until 2026-09-03 `/api/public/ipfs-media/[cid]` logged `[ipfs-media] ok …` **before pumping a single
byte**, so a transfer that died mid-flight was a 200 with a success line and nothing else. A counting
`TransformStream` now writes a second line on flush, read by correlation:

- `ok` **+** `streamed` → the client got the whole object.
- `ok` **with no** `streamed` → the transfer started and died.

`flush` does not run when a stream errors, and that absence IS the signal.

## 1. The seven cache-MISS transfers in one burst (11:42–11:43Z, `dpl_4XVGrK9BNtuprtzmqghPorfp68ed`)

| bytes | headers at | streamed at | outcome |
|---:|---:|---:|---|
| 6,211,907 | 506 ms | 2,911 ms | ✅ |
| **7,735,665** | 1,291 ms | — | ⛔ `body timeout after 12000ms` |
| 2,233,832 | 191 ms | 525 ms | ✅ |
| 2,462,918 | 201 ms | 334 ms | ✅ |
| 2,293,146 | 182 ms | 524 ms | ✅ |
| 2,531,243 | 165 ms | 448 ms | ✅ |
| **2,719,126** | 186 ms | — | ⛔ `body timeout after 12000ms` |

**2 of 7 — 29% — got their headers and then never finished.** Every one of the five that completed did
so in **334–2,911 ms** of wall time.

## 2. ⛔ THE OBVIOUS CAUSE IS REFUTED BY THE SAME TABLE

The tempting read is *"the big ones time out"*, and the fix would be to lower `MAX_PROXY_BYTES` (8 MB)
so large objects 302 to the gateway instead of streaming — which has independent appeal, because the
edge cache is measured to accept **4.03 MB** and refuse **16.75 MB**, so the 4–8 MB band pays full Fast
Data Transfer on every request and never amortises.

⭐ **But the second failure is 2.7 MB, and a 6.2 MB object completed in 2.4 s of body time.** Size is
not the discriminator. A ceiling change would not have prevented either failure, and shipping it as
the fix would have been a plausible mechanism dressed as a measurement.

⚠ **The `MAX_PROXY_BYTES` question is still worth asking** — 8 MB was chosen *"between the largest size
proven to cache and the smallest proven not to"*, which is a basis worth re-deriving on its own terms —
but it is a **Fast Data Transfer** question, not this one. Do not merge them.

## 3. What the data does say

The gateway **stalls**, independent of object size, on roughly a quarter of cache-MISS reads. That is
consistent with what this route's own header already records from a residential probe: *"one was a
36 MB object with a 0.07 s TTFB that was still streaming at 40 s."* Fast to first byte, then nothing.

⚠ **So the 12,000 ms body budget is not obviously the wrong number.** Everything healthy finished
inside 2.9 s. Raising it gives a stalled transfer longer to stay stalled; the five successes needed
none of it.

## 4. Options, none taken

1. **Retry once on a mid-body abort.** ⛔ The response is already a 200 with headers sent — a retry
   cannot re-send them. It would have to be a client-side concern.
2. **302 to ipfs.io instead of proxying** (CSP-safe here: `ipfs.io` is in both `img-src` and
   `media-src`). The browser then stalls instead of us, which is no better for the reader but costs
   zero Fast Data Transfer and stops charging us for failures.
3. **A second gateway as fallback** — real work, an infra decision, and outside what a pass should
   choose alone.
4. **Nothing.** `<img onError>` already advances on the aborted response, so the reader sees the
   fallback. The change tonight made the failure legible and bounded; that may be the right stopping
   point until someone decides on cost.

## 5. ⚠ Two things NOT to conclude

- ⛔ **"The fix did not work."** It was never claimed to make a stalled gateway fast. Its ledger entry
  says the outcome is *"a slower visible failure, not a new one"* — and the 29% is a rate that was
  **unmeasurable** before it.
- ⓘ **`/api/badge-image` is not involved.** One `Error: TimeoutError: ipfs-media body timeout after
  12000ms` is attributed to `/api/badge-image` in the same burst. That is the documented Vercel
  attribution smear, now carrying a string this session introduced. **Do not chase badge-image on it** —
  re-group on `requestPath` first, as CLAUDE.md says.
