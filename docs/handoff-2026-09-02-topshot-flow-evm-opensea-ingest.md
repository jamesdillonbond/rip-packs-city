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
