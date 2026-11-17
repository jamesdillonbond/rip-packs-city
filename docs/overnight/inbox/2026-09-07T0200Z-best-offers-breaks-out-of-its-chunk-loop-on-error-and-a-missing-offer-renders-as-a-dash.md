# `/api/best-offers` `break`s out of its chunk loop on a failed read, and the missing offer renders as a dash

> 🚨 **CORRECTED BY ITS OWN AUTHOR, 2026-09-07 ~08:3x PT. HALF OF THIS FILING IS REFUTED. Read this box before acting on anything below it.**
>
> **1. THE TRUNCATION CLAIM IS WRONG — refuted by naming the caller, which this filing never did.**
> · the route chunks at `CHUNK = 500`
> · its **one** caller, `CollectionTabClient`, slices at `CHUNK_SIZE = 200` **before** it fetches
> · `200 < 500`, so **the loop body runs exactly once, always** — there are no "remaining chunks" to discard, and `break` and `continue` are the same statement here.
> The original text read the defect off the CODE SHAPE. ⭐ CLAUDE.md says it twice — *"name the caller before you touch the function"* and *"a plausible mechanism is not a measurement"* — and this is what skipping that step produces: **a filed defect that does not exist.** ⛔ **Do NOT ship the `continue`; it would change nothing and close a ghost.**
> ⭐ The refutation is now **durable, not a note**: `__tests__/best-offers-chunking-cannot-truncate.test.ts` pins `CLIENT_CHUNK <= ROUTE_CHUNK` (three controls run — inverting it, removing the client's constant, and refactoring the route's loop away each red it). **If that inequality is ever inverted the truncation becomes real**, and the guard says so in its failure message.
>
> **2. THE RATE THIS FILING SAID TO MEASURE FIRST IS NOT MEASURABLE WITH THE INSTRUMENTS AVAILABLE — and the attempt is recorded so the next person does not repeat it.** Vercel runtime logs, production: a full-text search for the warn string over 3h returns nothing, **but the positive control fails too** — `best-offers` returns **zero log lines of any kind** in the same window, so the route did not run and the null says nothing. ⚠ **That is the control doing its job, not a clean result.** Widening helps only in principle: `7d` and `24h` full-text queries both **time out** before returning. The route is reached only when a signed-in reader analyses a **non-Top-Shot** wallet (the leg is skipped for Top Shot), which is rare enough not to appear in a short window.
> ➡ **What would actually measure it:** a counter written where the error is caught (a `pipeline_runs` row or a `console.error` the Vercel error grouper aggregates), not a log grep. Until something counts it, the rate is unknown — **not zero**.
>
> **3. WHAT SURVIVES, UNCHANGED:** a failed `marketplace_offers` read leaves `bestOffer: null`, and the grid renders that as a dash — identical to *"nobody has bid"*. It is a genuine read-failed / genuinely-empty collapse, it is bounded to rows whose baseline was already null (the leg only ever RAISES an existing value), and the display fix is still a table-cell product call. **Item stays open on that half only.**


*Claude Code (cloud), 2026-09-06 ~19:0x PT / 2026-09-07T02:00Z · encountered while sweeping for the CLAUDE.md paged-read shape; LOOKED AT AND NOT FIXED — see "Why this was not shipped"*

## What it is

`app/api/best-offers/route.ts` reads `marketplace_offers` (the on-chain DapperOffersV2 standing-bid
feed — the non-Top-Shot leg) in `.in()` chunks of 500. On a PostgREST error it logs and **`break`s**:

```ts
if (error) {
  console.warn("[best-offers] marketplace_offers error:", error.message)
  break            // ← abandons EVERY REMAINING CHUNK, not just this one
}
```

Two distinct problems, and the second is the one the canon names:

1. **Truncation.** One failed chunk discards all later chunks. `/api/market`'s `loadEditionLookup`
   hits the identical situation twenty lines of code away and carries `complete = false` instead —
   so the correct pattern already exists in this repo and this route does not use it.
2. **The failure is published as a fact.** The route's own header says *"Editions with no standing
   bid in any source still return `bestOffer: null` (the grid renders a dash)"*. A read we could not
   finish therefore renders **identically to a Moment nobody has bid on**. That is the
   read-failed / genuinely-empty collapse, at the "read ok + unrenderable" third state.

## Severity — lower than it first looks, and the reason matters

This leg is an **enrichment** pass, not the source of the cell. `CollectionTabClient.flushOfferEnrichment`
only ever RAISES an existing value (`if (row.bestOffer && row.bestOffer >= fresh.bestOffer) return row`),
and the baseline arrives with the server page. So a failure usually means *"we did not improve the
number"*, which is invisible but not false.

**It is only a false claim when the baseline was already null** — then the dash is the whole answer,
and it came out of a read that failed. Top Shot is skipped entirely (richer edition/serial sources),
so the exposure is All Day / UFC / Golazos.

⚠ **Unmeasured, and it is what sizes this:** how often that chunk read actually errors. Nothing counts
it — the `console.warn` is the only record, and Vercel log search is not a rate. **Do not act on this
filing before measuring that**; a defect that fires never is not worth a client-side degraded state.

## Why this was not shipped

The route-side half (`continue` instead of `break`, plus a `degraded` field) is ten lines and safe.
The half that would make it *honest* is a client change: the dash has to become distinguishable from
"we could not check". That is a table-cell product decision on a surface another session shipped to
twice today (`CollectionMomentTable.tsx`, `24d60bcb0`), and adding a `degraded` field nobody reads is
the "instrument nobody keys on" trap — it would make the register say this was handled when the
reader still sees the same dash.

## Suggested disposition

1. **First, measure.** Add nothing; count the failures. If the rate is ~0 over a week, close this.
2. If it is non-zero: `continue` (never `break`) so one bad chunk stops costing the rest, return
   `degraded.dapperOffers`, and give the grid a third rendering for "unchecked" — a dash with a title,
   not a number and not a blank.
3. ⛔ Do NOT do (2)'s route half alone and call it fixed.

## Not findings (checked in the same sweep, recorded so they are not re-raised)

- `/api/market` `loadEditionLookup` — **correct already**, carries `complete = false` on the same shape.
- `/api/sniper-feed`, `/api/cron/ownership-onchain-walk`, `/api/cron/sync-topshot-ownership-dune`,
  `/api/cron/ufc-enrichment-drain`, `/api/topshot-fmv-populate` — the other `break`-after-`if (error)`
  hits in the tree. Not swept in depth; named so the next pass knows this filing did not clear them.
