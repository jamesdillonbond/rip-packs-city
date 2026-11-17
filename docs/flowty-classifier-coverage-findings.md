# Flowty classifier coverage findings (2026-05-05)

Two questions raised during the Track 4 audit:

1. Why are there 1,106 `collection = 'unknown'` rows in `flowty_transactions`
   (~38% of all rows over the last 10 days)?
2. Why are there zero `collection = 'golazos'` rows across all history?

Both turn out to be data-faithful, not classifier bugs. No address change is
needed in `lib/flowty-tx-classifier.ts`.

## Q1. Golazos: zero rows is correct

The classifier branch for golazos is correctly mapped to
`0x87ca73a41bb50ad5` (the LaLiga Golazos NFT contract on Flow Mainnet — see
`README.md`, `lib/analytics/flowty-links.ts`, the Cadence import patterns
across the repo).

Direct check:

```sql
SELECT COUNT(*) FROM flowty_transactions
WHERE '0x87ca73a41bb50ad5' = ANY(contracts_imported);
-- 0
```

`flowty_transactions` only ingests transactions that touch one of the two
NFTStorefrontV2 storefronts the scanner watches:

- `0x3cdbb3d569211ff3` — Flowty's fork
- `0x4eb8a10cb9f87357` — Dapper's NFTStorefrontV2

Golazos sales evidently use neither. Their marketplace runs on a separate
Dapper-internal contract that doesn't expose `ListingAvailable` /
`ListingCompleted` events on either of the watched storefronts, so they
never enter the scanner's pipeline at all. This is the same pattern
TopShot took with `TopShotMarketV3` — a per-collection custom marketplace
that operates independently of NFTStorefrontV2.

By comparison, the four collections that DO show up:

| collection | flowty fork | dapper storefront |
|------------|-------------|-------------------|
| topshot    | 1,154       | 696               |
| pinnacle   | 0           | 577               |
| allday     | 96          | 56                |
| ufc        | 2           | 0                 |
| golazos    | 0           | 0                 |

Verifying with a day of new traffic per the original triage was
unnecessary — the absence is total, not sparse.

## Q2. Unknown tail: long tail of off-platform collections

Of the 1,106 unknowns, 297 are successes and 809 are failures.

### Why successes go unknown (297 rows)

The scanner runs `inferCollectionFromEvents(events)` first; if no
`ListingCompleted` event has an `nftType` in the supported set
(`topshot | allday | golazos | ufc | pinnacle`), it falls through to
`inferCollection(script)` which scans for any of the five contract
addresses in the script. Successes that survive both checks are sales of
NFT collections we don't track.

Top non-generic addresses in success-unknown `contracts_imported`
(after excluding storefronts, FT/NFT interfaces, DUC/HybridCustody/Flow):

| addr | count | note |
|------|-------|------|
| `0xe544175ee0461c4b` | 246 | unidentified — likely an off-platform Flow NFT |
| `0x49a7cda3a1eecc29` | 169 | unidentified |
| `0x26836b2113af9115` | 77  | unidentified |
| `0x8ebcbfd516b1da27` | 29  | unidentified |
| (other long tail)   | <10 | ditto |

None of these addresses appear anywhere in the codebase. They aren't
TopShot / AllDay / Golazos / UFC / Pinnacle. They're off-platform Flow
NFTs (Goated Goats, Doodles on Flow, Flovatar, Flowty drops, etc.) that
trade through the Flowty fork. We don't track them because they're not
part of the dapper-collectible scope.

### Why failures go unknown (809 rows)

Failed transactions often abort before the NFT contract is referenced —
the script imports run, but the failure is at the storefront / capability
layer (storage cap, missing storefront, missing collection capability).
The CLAUDE.md note already calls this out:

> failure rows often classify as `collection: unknown` because failed txs
> don't emit `ListingCompleted` events.

Concretely, all 809 failure-unknowns emit only `FlowToken.TokensWithdrawn`,
`FlowToken.TokensDeposited`, `FungibleToken.Withdrawn/Deposited`, and
`FlowFees.FeesDeducted` — i.e. only the fee-payment events. The NFT
contract events that would have identified the collection were never
emitted because the tx aborted earlier.

### Conclusion

Per the Track 4 instruction ("don't try to drive unknown to zero — some
Flow txs genuinely aren't sales (transfers, listings without buys, etc.)
and unknown is appropriate for those"), the unknown tail is the expected
shape:

- ~75% (809) are failures that aborted before NFT emission — `unknown` is
  the correct classification.
- ~25% (297) are successful sales of off-platform NFT collections we
  don't support — `unknown` is also correct.

No classifier code change is warranted. The 5 supported-collection
branches resolve correctly when the txs are within scope; the rest are
appropriately unclassified.

## Side note: DUC address discrepancy

CLAUDE.md lists `DUC: 0x82ec283f88a62e65`. The actual mainnet DUC contract
the codebase uses everywhere is `0xead892083b3e2c6c` (see
`lib/cadence/purchase-moment.ts`, `lib/flow.ts`, `app/api/flowty-sales/route.ts`,
etc.). The `0x82ec283f88a62e65` value may be a testnet artifact. Out of
scope for this ticket — leaving the discrepancy for the next CLAUDE.md
edit.
