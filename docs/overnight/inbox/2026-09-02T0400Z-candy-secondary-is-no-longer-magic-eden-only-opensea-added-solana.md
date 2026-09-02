# Candy secondary is no longer Magic-Eden-only — OpenSea added Solana, Candy is a launch partner

**Filed 2026-09-02 04:00Z (2026-09-01 21:00 PT) · cloud autonomous pass · read-only, nothing shipped**

## The external fact

OpenSea added **Solana NFT trading** on ~**2026-08-31** — its first non-EVM NFT chain since a 2022
beta that covered only 165 collections. **Candy Digital is a named launch partner.** Candy CEO Tad
Smith posted that Candy "is a launch partner … and we are **live now**".

⚠ Sourcing caveat, stated because it changes urgency: The Block's same-day piece said trading was
*"expected to go live this week"*. **"Live now" is Candy's own claim, not third-party confirmation.**
Treat go-live as "now or imminent", not as verified.

## Why it matters here: every Candy market surface is Magic Eden only

| route | source |
|---|---|
| `app/api/candy-sales-indexer/route.ts` | ME `/v2/collections/{symbol}/activities` |
| `app/api/candy-listings-indexer/route.ts` | ME `/v2/collections/{symbol}/listings` |
| `app/api/ingest/candy-offers/route.ts` | ME activities + `/v2/wallets/{addr}/offers_made` |

`lib/collections.ts` also points Candy item and user links at `magiceden.io` only.

**Live confirmation, not inference:** across every Candy sale RPC has ever recorded,
`count(distinct marketplace) = 1`. A Candy trade that clears on OpenSea is captured **nowhere**.

### ⛔ The column that nearly fooled me

Candy sales rows carry `source: "solana_das"`, which reads like on-chain provenance — and if sales
*were* derived on-chain, OpenSea trades would settle on Solana and be picked up for free. **They are
not.** That label names the **resolver** (DAS maps mint → edition); the sales themselves come from
Magic Eden's HTTP activities feed, and `marketplace` is hardcoded `'magic_eden'` on every row. The
route header says so in its first four lines.

**Read the route header, not the source column.** I was one step from filing "no impact, it's
on-chain".

## Honest scoping — this is accuracy, not revenue

Candy is small today: **3,041 sales / $25,115 across 30 days**. Nobody should read this as an
emergency, and the fix does not need to jump any queue.

⚠ **But the listings side is the sharper risk, and it is the estate's recurring failure shape.** Both
indexer headers note that Magic Eden lists ~0 Candy items under a "quest-hold rule", so the ask feed
is a deliberate permanent no-op. If sellers list on OpenSea instead, the Candy deals / offer-spread /
sniper / floor family stays empty **while a real market exists** — and an empty board says *"no
market"* when the truth is *"we are blind"*. Same class as the boards that rendered timeouts as data.

## Remediation is reuse, not greenfield

RPC already has OpenSea plumbing — for **Panini**: `OPENSEA_API_KEY`,
`app/api/panini/listings/route.ts` (`/api/v2/listings/collection/{slug}/best`) and
`app/api/panini/market-stats/route.ts` (`/api/v2/collections/{slug}/stats`). ⚠ Those calls are
**Ethereum-scoped** (`/chain/ethereum/...`), so the auth and fetch shape port but the chain path does
not.

## ✅ SETTLED 04:05Z — `solana` IS a supported chain in OpenSea API v2

Answered empirically rather than from docs (their `supported-chains` doc page is now just a
deprecation notice). **`GET https://api.opensea.io/api/v2/chains` is PUBLIC — HTTP 200, no key** — and
returns 29 chains including:

```json
{"chain": "solana", "name": "Solana", "symbol": "SOL", "supports_swaps": true,
 "block_explorer": "Solscan", "block_explorer_url": "https://solscan.io/"}
```

So the remediation path is real, not hypothetical: port the Panini fetch shape to a Candy reader on
`chain=solana`, add it as a SECOND source to sales/listings/offers, and stop hardcoding
`marketplace: 'magic_eden'`. ⚠ Dedup on transaction signature — an aggregated listing could otherwise
double-count against the ME feed.

### ⛔ CORRECTION — my "don't chase Flow EVM" line was WRONG (Trevor caught it)

The same list contains `{"chain": "flow", ..., "block_explorer_url": "https://evm.flowscan.io"}`, i.e.
Flow **EVM**, not Cadence. I first wrote that off as a trap: *"RPC's Flow collections are Cadence, so
this is not a Top Shot data source."* **The VM claim is right; the conclusion is wrong.**

**Top Shot moments ARE bridged Cadence → Flow EVM and ARE tradable on OpenSea:**

- Dapper ships official bridging contracts (`dapperlabs/nba-smart-contracts/evm-bridging/`).
- `BridgedTopShotMoments` **mainnet `0x84c6a2e6765E88427c41bB38C82a78b570e24709`**, Flow EVM chain
  **747** — ERC-721 (+enumeration/burn, ERC-2981), **1:1 to a Cadence-native moment** via
  `CrossVMMetadataViews.EVMPointer`.
- Live collection `opensea.io/collection/nba-top-shot`, created Feb 2025 by Dapper.

⚠ **The reusable lesson: a "wrong VM" argument is not sufficient when a BRIDGE exists.** Check for one
before dismissing a cross-VM lane — I nearly steered the next session away from a real market.

### 📏 …and yet: do NOT build it. The lane is measured dead.

| | Top Shot volume |
|---|---|
| **Cadence (what RPC tracks)** | **$24,037/day** — 109,714 sales / $721,123 per 30 d |
| **OpenSea Flow EVM** | **$0.85 / 24 h**; $211.4K lifetime *since Feb 2025* |

**≈28,000 : 1.** The entire lifetime OpenSea total is under **nine days** of our Cadence volume.
62,844 items bridged, only **562 listed (<1 %)**, floor $0.21. A Flow-EVM indexer would add ~0.004 %
of volume. **Same shape as `atlas-proxy` — real, deployed, and not worth wiring.**

⚠ AllDay/Golazos not separately checked, deliberately: AllDay's Cadence volume is ~13× smaller than
Top Shot's, so it cannot clear a bar Top Shot fails by four orders of magnitude.

**If it ever matters the build is small** — `evm_chains` already holds `flow_evm_mainnet (747)`,
`lib/evm-rpc.ts` is chain-parameterised, the `flowevm-proxy` worker and
`EVM_PROXY_{URL,SECRET}_FLOW_EVM_MAINNET` exist, and there is an EVM transfers ingest. ⚠ But the
scaffold has **never run**: `wallet_links` = 0, zero `flow_evm` collections, and `max(started_at)` for
any `%evm%` pipeline is **NULL**. Untested, not merely idle.

**Re-check trigger, not a date:** revisit only if OpenSea Top Shot 24 h volume clears **~$500/day**
(≈2 % of Cadence). That number is on the public collection page and needs no API key.

### (superseded) ⛔ TRAP — OpenSea's `flow` is Flow **EVM**, NOT Cadence. Do not chase it.

The same list contains `{"chain": "flow", "name": "Flow", ...}`, which looks like it might open an
OpenSea data source for Top Shot / AllDay / Golazos. **It does not.** The tell is in the same record:
`"block_explorer_url": "https://evm.flowscan.io"` — this is **Flow EVM**. RPC's Flow collections are
**Cadence** NFTs and do not live there. Anyone reading "OpenSea supports Flow" and planning against it
is planning against the wrong VM.

### ⚠ BLOCKER for any further probing — and a possible live gap

Every OpenSea v2 endpoint beyond `/chains` returns
`401 {"errors":["Missing an API Key, which is required for this request."]}` — confirmed against
`/v2/collections/candy-mlb` and `/v2/collections?chain=solana`.

**`OPENSEA_API_KEY` is NOT in `.env.local`** (verified by name; no value read). RPC's existing OpenSea
callers read it as `process.env.OPENSEA_API_KEY ?? ""`, i.e. **they fail soft to an empty key**. So:

- I cannot verify from here whether Candy's collection is actually live on OpenSea, or what its slug is.
- ⚠ **Worth Trevor confirming the key exists in Vercel**, because if it does not, `app/api/panini/listings`
  and `app/api/panini/market-stats` are already 401ing silently on a user-facing surface. Those are
  request-time routes, not crons, so they write no `pipeline_runs` row and **green pipelines do not
  cover them** — the Panini cron pipelines are 3,378/3,378 ok and say nothing about this.

## The original open question, now answered above

## ⚠ The open question — deliberately not guessed

**Whether OpenSea's public API v2 exposes Solana listings/events yet, and under what `chain` value,
is UNVERIFIED.** The API overview page does not enumerate supported chains. Settle it against
OpenSea's "Get supported chains" endpoint *before* designing anything — a marketplace launching a
chain in its UI does not imply same-day public API coverage.

Two outcomes, both actionable:

- **Solana is in the API** ⇒ port the Panini fetch shape to a Candy OpenSea reader, add a second
  source to sales/listings/offers, and stop hardcoding `marketplace: 'magic_eden'`. ⚠ Dedup on
  transaction signature: an aggregated listing could otherwise be double-counted against the ME feed.
- **Solana is not in the API yet** ⇒ the gap is real and unclosable from the API side today. The
  honest interim move is to **say so on the Candy surfaces** rather than let an empty board imply an
  empty market, and to re-check on a dated trigger.

## Smallest correct first step

Regardless of which outcome: **`source: "solana_das"` and the hardcoded `marketplace: 'magic_eden'`
should be corrected**, because they are what makes the blindness invisible. A `marketplace` column
that can only ever hold one value cannot show coverage loss — which is exactly why
`count(distinct marketplace) = 1` looked like a fact about the market instead of a fact about the
indexer.
