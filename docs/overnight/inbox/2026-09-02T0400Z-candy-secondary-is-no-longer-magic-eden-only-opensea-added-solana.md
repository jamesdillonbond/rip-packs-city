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
