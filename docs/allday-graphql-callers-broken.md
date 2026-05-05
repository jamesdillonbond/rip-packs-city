# AllDay GraphQL callers silently broken (filed 2026-05-05)

## Summary

`nflallday.com/consumer/graphql` removed `getMintedMoment(momentId)` and the `MintedMoment` type entirely in a prior schema migration. Five repo callers still issue queries against this field. Each call site `try/catch`-es the `errors[]` array and returns null defaults, so the breakage never surfaces as an exception — it surfaces as quietly-empty data in dependent features.

Discovered while writing the sales-serial-backfill edge function (commit landing alongside this doc). The replacement is `searchMomentNFTsV2(input:{filters:{byFlowIDs:[Int]!}})`, which exposes `serialNumber`, `flowID`, `editionFlowID`, plus full edition / set / play metadata in a single batch-friendly call. The backfill function uses this replacement against the proxy worker `/allday-consumer` route.

## Affected files

- [lib/alldayGraphql.ts](../lib/alldayGraphql.ts) — the helper. Currently throws on `errors[]`, but every caller catches the throw and returns nulls.
- [app/api/allday-wallet-search/route.ts](../app/api/allday-wallet-search/route.ts) — `fetchMomentGraphQL(id)` returns `{ flowId: null, serial: null, ... }` defaults on every call.
- [app/api/allday-sets/route.ts](../app/api/allday-sets/route.ts) — `fetchMomentGQL(momentId)` returns `{ flowId: null, tier: "COMMON", lowestAsk: null }` defaults.
- [scripts/backfill-residual-edition-metadata.mjs](../scripts/backfill-residual-edition-metadata.mjs) — the `hydrateOneAllDay` path. Uses `allEditions` (not `getMintedMoment`) so probably still works for the bulk lookup, but worth re-verifying.
- [scripts/backfill-edition-metadata.mjs](../scripts/backfill-edition-metadata.mjs) — same bulk-hydration pattern as the residual-metadata script.

## Production impact (estimated, needs verification)

- **wallet-search**: AllDay wallet pages probably show null/empty serial + tier + lowestAsk fields where they previously rendered real values.
- **allday-sets**: Set browser likely missing per-moment tier and ask info for AllDay.
- The two backfill scripts probably ran with very high failure cohorts but — because they catch and continue — the cohort just never shrank past a baseline.

Concrete impact would be measurable by greppping production logs for `flowId: null` shapes coming back from these routes, or by comparing rendered AllDay wallet pages against a known reference moment.

## Suggested fix

Two-step:

1. **Make `lib/alldayGraphql.ts` errors loud, not silent.** The helper already throws on `errors[]`, but all four call sites swallow the throw with a `try/catch` returning defaults. Either remove the catch (let the throw propagate), or branch on error code so legitimate empty results stay defaulted while schema-rejection errors propagate.

2. **Migrate each caller to the right replacement query.** For per-moment serial / tier / ask info, switch to `searchMomentNFTsV2(input:{filters:{byFlowIDs:[Int!]}})` against `/allday-consumer` via the proxy worker. Selection set proven to work:
   ```graphql
   edges {
     node {
       flowID
       serialNumber
       editionFlowID
       edition {
         tier
         set { flowID name }
         play { id metadata { playerFullName teamName } }
       }
     }
   }
   ```
   Note: `byFlowIDs` accepts `[Int]`, not `[String]`. The newer `byFlowIDsV2` accepts `[UInt64]` (a custom GraphQL scalar), needed only if AllDay nft_ids ever exceed 32-bit Int range — current ids are ~10M, well under.

## How this was discovered

Probe A on 2026-05-05: hit `nflallday.com/consumer/graphql` from Vercel egress with the exact headers `lib/alldayGraphql.ts` sets. The 422 response body returns `Unknown type "MintedMoment"` and `Cannot query field "getMintedMoment" on type "Query". Did you mean "getPinnedMoments"?`. Schema rejection, not a network or auth issue. Subsequent probes against `searchMomentNFTsV2` returned the type whitelist (`MomentNFTFilters` accepts `bySetFlowIDs | byFlowIDs | byPlayFlowIDs | byFlowIDsV2`) and confirmed the path works.

Full session log lives in the conversation that produced commit `<sales-serial-backfill final>`.

## Out of scope for this ticket

- The backfill function (handled in the Track 1 commit).
- `searchMomentNFTsV2` integration for *live* sales / new-moment ingestion paths — those use Cadence on-chain scripts via `app/api/allday-sales-indexer/route.ts` and don't depend on this GQL.
- Any TopShot GraphQL paths — TopShot's `getMintedMoment` on `public-api.nbatopshot.com/graphql` is still working as of 2026-05-05.
