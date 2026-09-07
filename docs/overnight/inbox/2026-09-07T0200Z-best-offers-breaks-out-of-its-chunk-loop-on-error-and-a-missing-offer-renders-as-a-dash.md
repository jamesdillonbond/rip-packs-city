# `/api/best-offers` `break`s out of its chunk loop on a failed read, and the missing offer renders as a dash

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
