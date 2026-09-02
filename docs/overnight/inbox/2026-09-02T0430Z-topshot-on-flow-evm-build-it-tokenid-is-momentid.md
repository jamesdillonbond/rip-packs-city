# Top Shot on Flow EVM / OpenSea — BUILD IT, and `tokenId` is already our `moment_id`

**Filed 2026-09-02 04:30Z (2026-09-01 21:30 PT) · read-only investigation, nothing shipped**
**⛔ This REVERSES my own "do not build" call from 30 minutes earlier.** Trevor reframed it and was
right; the on-chain read then made it cheap. Both of my earlier errors are recorded at the bottom
because the reasoning failure is the reusable part.

## The contract — verified on-chain, not from docs

`BridgedTopShotMoments` — **`0x84c6a2e6765E88427c41bB38C82a78b570e24709`**, **Flow EVM chain 747**.
Read through the **public** RPC `https://mainnet.evm.nodes.onflow.org` (no key, no proxy):

| call | result |
|---|---|
| `eth_chainId` | `0x2eb` = **747** ✓ |
| `name()` | **"NBA Top Shot"** |
| `symbol()` | **"TOPSHOT"** |
| `totalSupply()` | `0xf57b` = **62,843** |

That 62,843 independently corroborates OpenSea's reported **62,844** items — two unrelated sources
agreeing, which is the check I actually trust here.

## 🔑 The finding that makes this cheap: no mapping layer exists or is needed

```
tokenByIndex(0) -> 46663165
tokenURI(...)   -> .../v1/topshot/moment/46663165
```

**The ERC-721 `tokenId` IS the Cadence Top Shot momentID, verbatim** — and the tokenURI is Dapper's own
metadata endpoint keyed by the same id.

Our `wallet_moments_cache.moment_id` for `nba_top_shot` is numeric, 5–8 chars, spanning
**79,830 → 52,683,767**, with 40,630 of a 200k sample in the 46M–47M band. `46663165` sits squarely in
that space. **Flow-EVM ownership and sales therefore join the existing edition/serial model on
`moment_id` directly — zero translation, no lookup table.**

⚠ Moment `46663165` is **not** in our `wallet_moments_cache`. That is NOT a schema mismatch — `wmc`
only holds wallets we scan, so it is a coverage artifact. It is, though, a concrete instance of the
blindness: a real bridged moment we cannot currently see.

## Why build it, given the volume is trivial

| | Top Shot volume |
|---|---|
| Cadence (tracked) | **$24,037/day** — 109,714 sales / $721,123 per 30 d |
| OpenSea Flow EVM | **$0.85 / 24 h**; $211.4K lifetime since Feb 2025 |

≈28,000 : 1. **I originally treated that as the answer. It is the wrong frame.** RPC's stated gate is
accuracy and completeness on an ALL-ROWS denominator. Cadence-only is a *partial* view of Top Shot;
Cadence + Flow EVM is the **only complete one**, and no competing tool has it.

**Low volume makes it cheap, not worthless.** 62,843 tokens, **562 active listings** (<1 %), a handful
of trades a day — a rounding error to index, and a categorical claim to own.

## Scope

1. **Ownership** — `Transfer` logs via `getLogs` on chain 747. `lib/evm-rpc.ts` already exposes
   `getLogs`/`ethCall` and is chain-parameterised; `evm_chains` already holds `flow_evm_mainnet (747)`.
2. **Sales / listings** — OpenSea API v2 with `chain=flow` (needs `OPENSEA_API_KEY`), or Seaport events
   on-chain. ⚠ Write a real `marketplace` value (`opensea`) — **do not hardcode it**, which is exactly
   the defect that made the Candy blindness invisible.
3. **Join** — `tokenId::text = wallet_moments_cache.moment_id`. That is the whole integration.

⛔ **Known blocker, and it is not what it looks like:** `EVM_PROXY_URL_FLOW_EVM_MAINNET` is present in
`.env.local` but its **value is 2 characters — effectively blank.** That is why the scaffold has never
run: `wallet_links` = 0, zero `flow_evm` collections, and no `%evm%` pipeline has a single recorded
start. **The public RPC needs no key**, so the proxy is not on the critical path for a read-only
indexer — but nobody should assume the scaffold works until something exercises it.

## ⚠ Two wrong calls in one investigation — the reusable part

1. **"OpenSea's `flow` is EVM, ours is Cadence, don't chase it."** The VM claim was right and the
   conclusion was wrong: Dapper ships an official bridge. **A "wrong VM" argument is not sufficient
   when a bridge exists.**
2. **"Volume is 28,000:1, don't build."** Sized on the wrong axis. **When a product's stated gate is
   completeness, "too small to matter" is a category error — ask whether it closes a gap nobody else
   has closed.**

Both came from reasoning rather than measuring. The measurement took four `eth_call`s.
