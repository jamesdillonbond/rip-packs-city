# Handoff — Top Shot on Flow EVM / OpenSea: ingest spec

**2026-09-02 · every fact below was verified by direct on-chain read, not from docs.**
Rationale and the errors made on the way: `docs/overnight/inbox/2026-09-02T0430Z-topshot-on-flow-evm-build-it-tokenid-is-momentid.md`.

**Why build a lane worth $0.85/day:** completeness is the product. Cadence-only is a *partial* view of
Top Shot; Cadence + Flow EVM is the only complete one, and no competing tool has it. The tiny volume
makes it **cheap to index**, not worthless — 62,843 tokens, 562 active listings, most 10k-block
windows contain zero transfers.

## Constants (all verified live)

| thing | value |
|---|---|
| RPC | `https://mainnet.evm.nodes.onflow.org` — **public, no key, no proxy** |
| Chain | **747** (`eth_chainId` → `0x2eb`) |
| Contract | `0x84c6a2e6765E88427c41bB38C82a78b570e24709` (`BridgedTopShotMoments`) |
| Underlying bridged ERC-721 | `0x50ab3a827ad268e9d5a24d340108fad5c25dad5f` |
| Seaport | `0x0000000000000068f116a894984e2db1123eb395` |
| `Transfer` topic0 | `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` |
| `OrderFulfilled` topic0 | `0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31` |
| Supply at time of writing | `totalSupply()` = **62,843** (OpenSea reports 62,844 — independent corroboration) |

## The join — the reason this is cheap

`tokenByIndex(0)` → `46663165`; `tokenURI(46663165)` → `…/v1/topshot/moment/46663165`.
**The ERC-721 `tokenId` IS the Cadence momentID.** Our `wallet_moments_cache.moment_id` for
`nba_top_shot` is numeric, 5–8 chars, 79,830 → 52,683,767, with 40,630 of a 200k sample in the 46M
band. **Join on `tokenId::text = moment_id`. No mapping table, no translation.**

## Classifying a Transfer — three shapes, all distinguishable

1. **SALE** — same tx contains a Seaport `OrderFulfilled` AND `tx.to` = Seaport.
   Verified: `0x9c90802ea8fbe7ebd7c549761f1f13eb7465b8b5b17edd1fd362499d773c033d`.
2. **BRIDGE-IN MINT** — `from = 0x0`. Verified: `0xfb21ccceb4460377c7c2865037527d91fdfa0e2a45f41981db4b1c24b1c5258f` (3 moments, one tx).
3. **WRAP / UNWRAP** — `tx.to` = the wrapper itself, Transfers on BOTH `0x84c6…` and `0x50ab…`.
   Verified: `0x2155a1a191428e5e79f9ea298b7b87dc7c210e19a2899a10088530ea832e6fdd`. **Not a sale — do not book it as one.**

## ⛔ The trap that will bite whoever builds this

A bridged moment's EVM owner is a **COA** such as `0x00000000000000000000000205f7a09cac2c8f35`. It
*looks* like `0x…0002` + a Cadence address. **It is not.** Flow REST rejects `05f7a09cac2c8f35`
(*"invalid for chain flow-mainnet"*) while a real address (`0x0d744d23165bfb6c`) resolves.
**COA addresses are ALLOCATED, not derived.**

- ✅ Safe without solving it: **sales, prices, volume, listings, per-edition comps** — none need a
  Cadence wallet.
- ⛔ Needs it: **wallet-page attribution.** Unsolved. Would require a Cadence-side resolution
  (likely a script via Flow REST `/v1/scripts`). **Do not ship a string-derived mapping.**
- Control proving the COA is real: `balanceOf(COA)` = **186**. Also: `balanceOf` = **0** for all ten
  of our largest tracked whales — the wallets we track are not bridging.

## 💰 Price parsing — DECODED FROM A REAL SALE, and the trap that books $0

Worked fully against `0x9c90802ea8fbe7ebd7c549761f1f13eb7465b8b5b17edd1fd362499d773c033d`.

`OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient,
SpentItem[] offer, ReceivedItem[] consideration)` where
`SpentItem = (uint8 itemType, address token, uint256 identifier, uint256 amount)` and
`ReceivedItem` is the same plus a trailing `address recipient`. `itemType`: **0 = native, 1 = ERC-20,
2 = ERC-721**.

Decoded values from that tx:

| field | value |
|---|---|
| offer (1 item) | itemType **1 (ERC-20)**, `0xd3bf53dac106a0290b0483ecbc89d40fcc961f3e`, amount `50500000000000000000` |
| consideration 1 | itemType **2 (ERC-721)**, `0x84c6…24709`, identifier **51214935**, amount 1 → offerer |
| consideration 2 | itemType 1, amount `505000000000000000` → `0x0000a26b00c1f0df003000390027140000faa719` (**OpenSea fee recipient**) |
| consideration 3 | itemType 1, amount `2525000000000000000` → creator royalty |

Payment token resolved on-chain: `name()` = **"Wrapped Flow"**, `symbol()` = **WFLOW**,
`decimals()` = **18**. So: **price = 50.5 WFLOW**, fees 0.505 (**1 %** OpenSea) + 2.525 (**5 %**
creator royalty), seller nets **47.47**. `identifier` **51214935** is the Top Shot momentID — the join
key, straight out of the event.

### ⛔ THE TRAP
This sale is a **bid acceptance**: the buyer's payment is the **`offer`** (an ERC-20), and the NFT
appears in `consideration`. A parser that computes price by summing `consideration` items of
**itemType 0 (native)** — the obvious first implementation — returns **0 for this sale**. Measured:
native total = **0 wei**. It would book a real trade at **$0.00**, silently, and poison the FMV comp
for that edition. Same family as the documented "a timeout renders as $0" class.

**Rule — handle BOTH directions:**
- **Listing purchase** (buyer pays): NFT is in `offer`; price = Σ `consideration` amounts (native or
  ERC-20) — i.e. seller proceeds + fees + royalty.
- **Bid acceptance** (seller accepts): NFT is in `consideration`; price = the **`offer`** amount.
- **Decide by where itemType 2 sits**, never by assuming a direction.
- Accept native (itemType 0) **and** WFLOW (itemType 1, `0xd3bf53da…`) as payment. ⚠ Any other ERC-20
  should be recorded but flagged, not silently valued at zero.

### FLOW → USD
`sales.price_usd` needs a historical rate. **`fetchFlowUsd()` already exists**
(`lib/pack-drops-board.ts:164`) but is a **spot** rate. The historical model to copy is
`solUsdOn(atMs)` (`lib/chains/solana/das.ts:237`), which keys CoinGecko's
`/coins/{id}/history` on a `dd-mm-yyyy` UTC date — add the same with id `flow`.
⚠ Store `price_native` + `currency` regardless, so a missing rate degrades to a null USD rather than
losing the trade.

## Build order (each step independently useful)

**1 · Sales (highest value, no blockers).** Scan `Transfer` logs on `0x84c6…`; for each tx, fetch the
receipt and keep those with a Seaport `OrderFulfilled`. Price from the `OrderFulfilled` consideration.
Write to `sales` with `collection_id` = TopShot, `nft_id`/`moment_id` = tokenId,
**`marketplace = 'opensea'`, `source` = a NEW distinct tag** (e.g. `flow_evm_seaport`).
⚠ **Do not hardcode `marketplace`** — that is precisely the defect that made the Candy blindness
invisible (see the annotation in `app/api/candy-sales-indexer/route.ts`).
⚠ **A new `source` tag WILL trip `docs/overnight/flow-ecosystem-watch.md`'s standing
"no new source tag vs baseline" check.** That is correct behaviour — announce it in the same commit
so the next watch run does not read it as an unknown venue appearing.

**2 · Ownership / supply.** `Transfer` logs give current EVM holder per tokenId; `balanceOf(COA)` and
`totalSupply()` are cheap cross-checks. Store the COA as the holder; do **not** pretend it is a
Cadence wallet.

**3 · Listings (optional).** Needs OpenSea API v2 `chain=flow` and an `OPENSEA_API_KEY`.
⚠ `OPENSEA_API_KEY` is **absent from `.env.local`**, and RPC's callers read it as `?? ""` (fail soft →
401). Confirm it exists in Vercel before relying on it. Everything in steps 1–2 needs no key at all.

## Operational notes

- ⚠ **`eth_getLogs` is capped at a 10,000-block range** (`-32614`). Flow EVM is ~1 s blocks.
- Head block at time of writing: **77,184,594**. Contract live since ~Feb 2025.
- Full backfill ≈ **4,700 paged calls**, one-time. Ongoing polling is almost always **zero logs** —
  measured: 0 transfers in each of the last 10k / 50k / 200k / 500k-block windows.
- ⛔ `EVM_PROXY_URL_FLOW_EVM_MAINNET` is present in `.env.local` but its **value is 2 characters —
  effectively blank.** That is why the EVM scaffold has never run: `wallet_links` = 0, zero
  `flow_evm` collections, and **no `%evm%` pipeline has a single recorded start.** Treat the scaffold
  as untested. The public RPC removes it from the critical path.
- Existing reusable pieces: `lib/evm-rpc.ts` (chain-parameterised `ethCall`/`getLogs`), `evm_chains`
  row `flow_evm_mainnet (747)`.

## Verification contract (do not verify on `ok`)

A pipeline that runs green while capturing nothing is this estate's recurring failure. Verify on:
1. `select count(*) from sales where marketplace = 'opensea'` — must become **> 0** after a backfill.
2. Spot-check one booked sale against its tx hash on `evm.flowscan.io`.
3. `select count(distinct marketplace) from sales s join collections c on c.id=s.collection_id where c.slug='nba_top_shot'` — must become **≥ 2**. Today it is 1, and that 1 is a fact about our indexers, not the market.
