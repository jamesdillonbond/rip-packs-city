# 🚨 The public Underpriced-#1s board **503s**, and the query behind it is **32 ms warm / 19,895 ms cold**

**Filed 2026-08-26 (PT) by Claude Code, from Trevor's box.** Found while verifying the
deal-board ingest fix — the ingest now works, and the board it feeds still fails.
**Reproducible, user-facing, and NOT caused by today's index work** (proof below).

⛔ **The obvious remedy is the one the 2026-08-15 filing already argues against, and I
nearly shipped it.** But this board is in a *different cost class* from the five that
filing analysed, and that is the new fact.

---

## 1. The failure, reproduced

```
GET https://www.rippackscity.com/api/public/insights/underpriced-serials
  -> 503 after 62s        (default limit; reproduced twice, ~10 min apart)

GET .../underpriced-serials?limit=5
  -> 200 in 18s, x-vercel-cache: MISS, meta.elapsed_ms = 17267
```

⚠ **The `limit` is a red herring** and worth stating so nobody chases it:
`fetchUnderpricedSerials` always issues `.limit(500)` and applies `opts.limit` **in JS
afterwards**, so both URLs run the *identical* database query. The two outcomes are the
same query on different cache states, not a limit effect.

✅ **The honesty layer is working correctly.** The route returns `boardUnavailable()`, so
the failure surfaces as a 503 rather than as an empty board — a failed read is not being
rendered as "no deals right now". That is the canon behaving exactly as designed.

⚠ **The PAGE is not obviously broken**: `/insights/underpriced-serials` returns 200 from
`x-vercel-cache: PRERENDER` in ~1 s with no error markers. The rows arrive from the API
client-side, so the user gets a shell that then fails to populate.

## 2. ⭐ The measurement that reframes it

Timed inside one `DO` block, same statement twice, so the second run is warm by
construction:

| | rows | time |
|---|---:|---:|
| **cold** | 7 | **19,895 ms** |
| **warm** | 7 | **32 ms** |

**622×.** And the query's whole working set is **3,069 buffers (~24 MB)** with **230 disk
reads**. At this instance's measured ~74 ms per cold random read, 230 × 74 ms ≈ **17 s** —
which is the number. **There is no plan defect here and nothing to optimise:** the board is
already tiny, it is simply always cold, because a 15-minute `s-maxage` on a low-traffic
public route means almost every execution is the first one in a long while.

ⓘ `EXPLAIN` corroborates cheapness: 7 rows out of 260 candidate listings, `Seq Scan` on
`topshot_conflated_editions` (1,042 rows, 16 buffers), 260 `editions_pkey` probes, and 260
FMV lookups now served by an **`Index Only Scan`** on the index built earlier today.

## 3. ⛔ NOT caused by today's index work — checked, not assumed

The covering-index change and the drop of its superseded sibling both landed shortly before
this was observed, so the first suspicion was mine.

- The FMV leg of this board uses the **new** index and is an `Index Only Scan`.
- The board's total is 3,069 buffers; the FMV leg is 1,499 of them, i.e. it is not the cost.
- The dropped index was a strict SUBSET of one that still exists, so no plan lost an option.
- The board's input, `topshot_active_listings`, held **280 active rows before** today's
  ingest and **272 after** — the candidate set is essentially unchanged.

**The 503 predates today and is a property of the cold path, not of the index estate.**

## 4. ⛔ The fix I was about to ship, and why the 2026-08-15 filing kills it

The natural move is to add `underpriced-serials` to `WARM_BOARDS` /
`refresh-insights-cache`, whose header describes precisely this failure mode. **Do not do
that without reading [2026-08-15T1200Z](2026-08-15T1200Z-the-insights-cache-warms-half-its-boards-and-reports-perfect-health.md) first.** It measured that cron and found:

- three of its five boards **fail the majority of ticks** (59.5% / 54.2% / 51.0%);
- the six board means **sum to ~60.0 s = the route's entire `maxDuration`**, so serialising
  is arithmetically impossible and was closed as a question;
- each failed warm burns a **full 30 s of DB time producing nothing**, ~90 s per 5-minute
  tick, so **"the refresher is a meaningful contributor to the saturation it exists to
  survive."**

**Adding a sixth board to a `Promise.all` that is already losing three of five is a
plausible way to make four of six lose.**

## 5. ⭐ What is genuinely new, and why it may still be the right home

**This board is not in the class that filing analysed.** Those five are heavy views —
10–12 s means, 29.x s maxes clipped by `statement_timeout`, tens of thousands of buffers.
This one is **32 ms warm on 3,069 buffers**. Its cold cost is latency on 230 random reads,
not work.

That distinction matters because the contention argument is about *work*, and this board
adds almost none once warm. A board that costs 32 ms in the steady state is close to free
to keep warm; the only expensive tick is the first.

👉 **Two options, and the choice is a judgement about the warm cron's budget, not a
diagnosis:**

1. **Add it to the lighter buffer warmer** (`/api/cron/warm`, `*/10` business hours,
   `maxDuration = 30`, currently two RPCs). It is a pure buffer warmer, not a snapshot
   writer, and its own header documents this exact "first hit after buffer eviction is
   multi-second" problem. Lowest blast radius; the board stays warm and the 15-minute
   `s-maxage` then almost always hits a warm DB. ⚠ Its first tick would pay the ~20 s cold
   cost against a 30 s ceiling — tight but one-off.
2. **Add it to the snapshot cache** (`WARM_BOARDS` + a `fetchUnderpricedSerialsDefault`
   builder + `readBoardOrLive` in the route). Strictly better for users — it survives
   saturation on a PK-keyed row and gains the stale-but-honest rung — but it is the
   contention trade the 08-15 filing reserves for Trevor.

⛔ **Not shipped.** Option 1 is small and I would have taken it, but both options add load
to the cron layer that a standing filing identifies as part of the root cause, and this
repo's rule is that a freshness-vs-reliability trade on a public board is a product call.
**The measurement is the part that was missing; the decision is not mine.**

⚠ **One thing worth fixing regardless of which option wins:** the board's OG card
(`app/api/og/insights/underpriced-serials/route.tsx`) is already flagged in known-issues
**#30** as rendering a `Live deals` claim with **no age signal at all**. A board that 503s
for its own API is exactly the case where a social card asserting liveness is worst.
