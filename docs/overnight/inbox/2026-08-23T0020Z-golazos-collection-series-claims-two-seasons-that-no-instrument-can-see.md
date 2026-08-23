# `collection_series` claims LaLiga Golazos has Series 2 and Series 3 — no instrument we own can see a single moment from either, and the series filter offers both

**Filed 2026-08-22 (PT) by Claude Code, interactive.** Found while answering "do we have this
Golazos moment?" for edition 541 — the answer was yes, and the catalogue check beside it was
the finding.

## What I first said, and why it was wrong

I told Trevor that our Golazos catalogue "stops at Series 1" and that "anything from the last
two Golazos seasons almost certainly is not covered", on the strength of two facts:

- `editions` holds **575** Golazos rows, external_id contiguous 1..575, **all `series = 1`**,
  newest `game_date` **2023-06-04**, every row created in one pass on **2026-04-14**.
- `collection_series` lists **three** rows for Golazos: Series 1 (2022-23), Series 2 (2023-24),
  Series 3 (2024-25).

Read together those look like an ingest that stopped after one season. ⚠ **That inference was
backwards, and it is the kind that sends someone to rebuild a pipeline that has nothing to
fetch.** The catalogue is not the half that lacks support.

## What two independent instruments actually say

| instrument | derived from | Golazos population | max edition id | above 575 |
|---|---|---|---|---|
| `wallet_moments_cache` | on-chain wallet syncs, 155 wallets, freshest row **2026-08-22 23:47Z** | 23,351 moments, 500 distinct editions | **575** | **0** |
| `nft_edition_map` | NFT ids resolved on-chain from REAL 2026 sales | 286 rows, 112 distinct editions | **572** | **0** |

And `unmapped_sales` for Golazos holds **9 rows in its entire history** (1 in the last 30 days),
so sales are not silently failing to find an edition either.

**Positive control, because "zero" is a null result and a null result needs one:** the same
predicate on the same population returns **2,427** rows above edition 500 and **7** above
edition 574 — it can see high ids; there simply are none above 575. Zero null keys, zero
non-numeric keys.

## What that means

The 575-edition catalogue looks **complete**, and the two `collection_series` rows for Series 2
and 3 are the unsupported half. They are not inert: `/api/collection-series` reads that table
directly to build the Collection tab's series dropdown, so the Golazos page offers a **Series 2**
and a **Series 3** filter that can only ever return nothing.

## ⚠ The blind spot this filing cannot close by itself

**Both instruments read the same Golazos contract, so both would be blind by construction to a
second contract.** If Dapper shipped later series under a new contract address, our wallet sync
would not see those moments, our sales indexer would not resolve them, and this table would
read exactly as it does now. The evidence is strong for "the contract we index has 575
editions" and only suggestive for "Golazos has 575 editions".

**The sandbox could not settle it** — egress denied CONNECT to `laligagolazos.com`,
`dapper.market` and `rest-mainnet.onflow.org`, so no external confirmation was possible.

## Recommended next step — a decision, not a fix

1. Someone with a browser opens `laligagolazos.com` and looks for any 2023-24 or 2024-25 moment.
2. **If none exists:** delete the two unsupported `collection_series` rows, which removes two
   dead filter options. ⚠ **Not done here.** It is a data mutation on a table that drives a
   live filter, and the case rests on instruments that share a blind spot — that is Trevor's
   call, not a drive-by.
3. **If they do exist:** the finding inverts into a real and much larger one — a whole contract
   we do not index — and the 575 catalogue is two seasons stale.

Either way, ⚠ **do not act on step 2 without step 1.** The cheap external check is the only
thing that separates the two conclusions, and they point opposite directions.
