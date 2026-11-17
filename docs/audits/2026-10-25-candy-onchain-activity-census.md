# Candy MLB on-chain activity census — 2026-10-25 (PT)

Cowork cloud, ~7:05–7:20 PM PT, read-only. Answers the open question in known-issues #58
("did Candy secondary volume move off Magic Eden to OpenSea after 10-11?") **without an
OpenSea key**, from Solana's public RPC (`api.mainnet-beta.solana.com`, no auth).

## Why this instrument is a census

Candy MLB assets are Metaplex Core assets in collection
`JkJA4yUBweFQdKAWNDhoFj8zHMZrQ1uZEYfjbkc3p8n` (`lib/chains/solana/normalize.ts`). A Core
`Transfer` of an asset that belongs to a collection must pass the collection account, so
**every ownership change — on any marketplace, or none — appears in
`getSignaturesForAddress(<collection>)`**. A marketplace sale additionally invokes that
marketplace's program (Magic Eden `M2mx93ek…`, Tensor `TCMPhJdw…`, …), which the
transaction's log messages name.

## Results

`getSignaturesForAddress` paged back to 2026-09-19: 20,000 signatures. Per PT day, the
quiet stretch after 10-15 is broken by bursts: 10-21 1,040 · 10-22 5,245 · 10-23 1,875.

Random samples, `getTransaction` each, programs and `Instruction:` names read from the logs:

| window | sampled | marketplace programs present | what the transactions are |
|---|---|---|---|
| 09-28 → 10-10 (PT) | 160 | Magic Eden in 54, Tensor in 3 | `BuyV2`+`CoreExecuteSaleV2` (ME sales) 16, `CoreSell` / `CoreCancelSell` (ME list/delist) 38, Tensor `ListCore` 3, Core `Update` 73, bare `Transfer` 30 |
| 10-12 → 10-25 (PT) | 260 | **none** | **260 of 260 are a bare Core `Transfer`** (ComputeBudget + MPL Core only) |

Signer of the post-10-11 transfers (separate sample of 120): **119 of 120 fee-paid and
signed by `BhA2Bfd8t2F2jDiUNdioGRJQt7MiaWo3Ro5H2Yt7APe2`**, single signer — the wallet RPC
already tracks as Candy's treasury (`candy_treasury_wallet_cache`, 1,644 serials).

## Conclusion

- Candy secondary trading **stopped** on 10-11; it did **not** move to OpenSea or Tensor.
  0 marketplace transactions in 260 samples bounds them at ~1.2 % of post-10-11 activity
  (95 %, rule of three), against ~35 % before.
- The post-10-11 bursts are the **issuer** moving its own inventory, not collector trading.
- So the `candy_sales_stale_hours` trust breach measures a **real market freeze**, not a
  blind venue, and an OpenSea key would not uncover hidden volume. #58 needs no key.

## Re-run

Python, standard library only (outbound HTTPS to the public RPC; ~10 min with the
throttling the public endpoint needs):

1. `getSignaturesForAddress(collection, {limit: 1000, before})` paged back to the window.
2. Sample signatures per window; `getTransaction(sig, {maxSupportedTransactionVersion: 0})`.
3. Programs = `^Program (\w+) invoke`; instructions = `^Program log: Instruction: (\w+)`;
   signer = `transaction.message.accountKeys[0]` with `header.numRequiredSignatures`.

Re-open #58 only if this census shows a marketplace program again.
