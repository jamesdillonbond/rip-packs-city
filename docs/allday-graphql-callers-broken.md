# AllDay GraphQL callers silently broken (filed 2026-05-05, triaged 2026-05-05)

## Summary

The AllDay schema removed the `getMintedMoment(momentId)` field and the
`MintedMoment` type. Two repo route handlers still issue queries against this
field. Each call site catches the throw and returns null defaults, so the
breakage surfaces as quietly-empty data rather than an exception.

The original draft of this doc named five files; on triage only two are
genuinely broken AllDay callers. The other three turned out to be either
TopShot helpers (where `getMintedMoment` still works), unused (`lib/alldayGraphql.ts`
has no importers), or not affected (the residual-metadata script uses
`allEditions`, which still resolves).

## Affected files

- [app/api/allday-wallet-search/route.ts](../app/api/allday-wallet-search/route.ts)
  — `fetchMomentGraphQL(id)` against `lib/allday` (public-api endpoint).
  Call site already throws (errors[] propagation in `lib/allday.ts`); the
  per-moment `try/catch` recovers with a placeholder row. Logs upgraded from
  `console.warn` to `console.log` so Vercel log search indexes them, and a
  route-level summary line counts how many moments fell back per request.

- [app/api/allday-sets/route.ts](../app/api/allday-sets/route.ts) —
  `fetchMomentGQL(momentId)` against `lib/allday`. The catch was silent;
  upgraded to `console.log` with the moment id. Sibling silent catches in
  `fetchLowestAskForPlay` and `enrichMissingPlaysWithGQL` upgraded similarly
  so any AllDay GQL regression surfaces in production logs.

## Files initially listed but cleared on triage

- [lib/alldayGraphql.ts](../lib/alldayGraphql.ts) — already throws on
  `errors[]` and has no importers in this repo. No call sites to update.

- [lib/allday.ts](../lib/allday.ts) — already throws on `errors[]`. The
  consumer-facing helper. No change needed.

- [scripts/backfill-residual-edition-metadata.mjs](../scripts/backfill-residual-edition-metadata.mjs)
  — uses `allEditions(first, after)` for AllDay, which still resolves on
  `nflallday.com/consumer/graphql`. Already logs HTTP / GQL errors on the
  AllDay path; no change needed.

- [scripts/backfill-edition-metadata.mjs](../scripts/backfill-edition-metadata.mjs)
  — TopShot script, hits `public-api.nbatopshot.com/graphql` where
  `getMintedMoment` still works as of 2026-05-05. Out of scope for this
  ticket.

## Triage decision

Both broken callers picked option (a) from the original ticket: catch the
throw and return a sensible default with a console.log so the breakage shows
up in Vercel runtime logs. Option (b) — switch to
`searchMomentNFTsV2(input:{filters:{byFlowIDs:[Int]!}})` — was rejected
because the fields the callers actually use beyond what v2 exposes
(`forSale`, `price`, `lastPurchasePrice`, `isLocked`, `createdAt`) have no
direct replacement in v2. Adding those would require a separate
`searchMomentListings` call plus on-chain Cadence for lock state — out of
scope for a triage commit.

`flowId` would be recoverable via v2 (it just echoes the input id), and
`tier` would be recoverable via `edge.node.edition.tier`. Both routes
already have on-chain `getMomentMetadata` paths that supply equivalent
data, so the v2 call wouldn't reduce dependency on Cadence either.

If a future task adds back per-moment listing data, the work pattern is:
issue a `searchMomentListings(input:{filters:{byFlowIDs:[$id]}})` call
alongside the existing on-chain meta fetch, and merge the listing fields
into the `WalletRow`.

## How this was discovered

Probe A on 2026-05-05: hit `nflallday.com/consumer/graphql` with the exact
headers `lib/alldayGraphql.ts` sets. The 422 response body returns
`Unknown type "MintedMoment"` and `Cannot query field "getMintedMoment" on
type "Query". Did you mean "getPinnedMoments"?`. Schema rejection, not
network or auth. Subsequent probes against `searchMomentNFTsV2` returned the
type whitelist (`MomentNFTFilters` accepts `bySetFlowIDs | byFlowIDs |
byPlayFlowIDs | byFlowIDsV2`) and confirmed the path works.

Both broken callers in this repo hit `public-api.nflallday.com/graphql`
(via `lib/allday.ts`), not the consumer endpoint. The schema migration
removed `getMintedMoment` from public-api too, so the failure mode is the
same.

## Out of scope

- The sales-serial-backfill edge function (handled separately; uses
  `searchMomentNFTsV2(byFlowIDs)` against the worker `/allday-consumer`
  route).
- TopShot GraphQL paths — TopShot's `getMintedMoment` on
  `public-api.nbatopshot.com/graphql` still works.
