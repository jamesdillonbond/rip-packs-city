# Candy / Solana Chain-Two — Interim Data Audit (June 22, 2026)

**Run type:** Autonomous scheduled task (interim check), read-only.
**Methodology spec:** [docs/candy-audit-checklist-2026-05-30.md](../candy-audit-checklist-2026-05-30.md) (June 22 interim section).
**Purpose:** Early data-availability check two weeks after Candy's targeted Solana marketplace open. This is **not** the tripwire decision — that is the July 8 firm audit. This catches show-stoppers early.
**Constraints honored:** No production DB touched. No schema changes. No code proposed. No Solana code added to the repo. No promotional content. CLAUDE.md and strategy docs untouched.

---

## TL;DR — interim go/no-go signal

**Lean NO-GO for a July 8 "go" decision — but the target itself still looks sound.**

The chain-two *target* (Candy on Solana / Metaplex Core) remains a good fit on every structural axis: defined edition/serial schema, an enforced-royalty standard, on-chain serials, and a dominant secondary venue (Magic Eden) with public APIs. **Tripwire conditions #2 (indexable schema) and #3 (chain-abstraction A–F) are effectively clear.**

What is **not** clear, and almost certainly won't be by July 8, is **tripwire condition #1: ≥30 days of real Candy Solana secondary sales history.** As of today (June 22):

- **Primary 2026 sales are not live yet.** candy.io reads "New drops, Coming Soon"; the flagship 2026 MLB Base Series ICONs show "On Sale Date: To Be Announced Soon." New sales are gated on a pending Stripe integration that Candy itself dates "around the week of June 22… but those dates are not final."
- **Migration completion was hedged, not confirmed.** Candy targeted "on or around June 8" for completing migration of *many* legacy assets, explicitly noting the date "is not guaranteed."
- **Secondary trading opens only *after* migration, for *legacy* assets first.** Even in the best case (legacy secondary opened mid-June), July 8 is **<30 days** of history — and likely thin and sporadic.
- **No verified Candy Digital Solana collection is publicly discoverable yet** on Magic Eden or via search. The data does not yet exist in a measurable form.

**Expected July 8 outcome:** checklist **Outcome #2 — defer chain-two by 30/60/90 days**, not Outcome #1 (go). Recommend re-running this audit's probes 2 and 4 against a *real, liquid, verified* Candy collection once one exists (realistically late July / August), and treating the 30-day sales-history clock as starting from the **first verified secondary-trading day**, not from the June 8 target.

---

## The crux: the data-availability clock has not cleanly started

The checklist's condition #1 assumes the 30-day clock began at a June 8 marketplace open. The primary sources show that assumption is optimistic:

| Milestone | Candy's stated status (as of the June 1 / June 15 / June 17 posts) |
|---|---|
| Legacy-asset migration to Solana | Targeted "on or around June 8," **not guaranteed**; "many items already more than halfway," final step is the on-chain mint |
| Self-custody (reveal private key, import to Phantom) | After an asset's migration reaches 100% |
| Secondary trading (legacy assets) on Magic Eden | **After** migration completes |
| New primary sales (2026 Base Series ICONs) | **Not live.** "On Sale Date: To Be Announced Soon." Gated on Stripe integration, "potential timing… around the week of June 22… not final" |
| Balance conversion / withdrawal feature | Targeted June 16 (tentative) |

Net: two weeks past the *target*, Candy's Solana footprint is still mid-rollout. The richest assets for an intelligence layer — the **2026 dynamic-stat ICONs** — have **zero** secondary history because they have not been sold at all yet.

---

## Probe 1 — Does Candy expose a public marketplace API?

**Finding: No public marketplace API found. candy.io is a login-gated Next.js/Vercel storefront for *primary* sales only; it does not run a secondary order book or expose documented public endpoints.**

- candy.io is a Next.js app served on Vercel (`/_next/...` assets, `dpl_…` deployment IDs in image URLs). Collection viewing is behind auth (`candy.io/login`, `candy.io/user`). The public-facing marketplace route (`candy.io/mlb/marketplace`) renders a marketing splash ("GET IN THE GAME", "New drops, Coming Soon"), not a queryable listings surface.
- No developer docs found. `docs.candy.io` (the checklist's guessed URL) did not surface; the FAQ and blog describe a fan storefront, not an API product. Support is a `fan-help@candy.io` mailbox, not a developer channel.
- Candy's own messaging is explicit that **secondary trading happens off-platform** on third-party Solana marketplaces. So candy.io is **not** the place RPC would source secondary listings/sales from regardless of whether it has an internal API.
- **Implication for RPC:** the chain-two data source will **not** be a "Candy API." It will be **on-chain (Helius DAS) + the secondary marketplace's public API (Magic Eden / Tensor)** — exactly the architecture the June 8 chain-two prebuild already anticipated. There is no partnership-API dependency blocking indexing; the blocker is simply that tradeable data doesn't exist yet.

**Recorded fields the checklist asked for:** API base URL → none public. Endpoints → none documented. Rate limits / auth / pagination → N/A (no public API). Structured edition fields → not exposed by candy.io publicly (see Probe 2 for where they live on-chain).

---

## Probe 2 — What does a Candy Metaplex Core asset look like on-chain?

**Finding: Well-characterized from Metaplex Core docs + Candy's own product-detail description. The schema is clean and indexable. Direct `getAccountInfo` on a real Candy mint could not be performed because no verified Candy Solana mint address is publicly available yet (see Blockers) — flag this for re-run on July 8.**

Metaplex Core asset model (authoritative, from Metaplex docs):

- **On-chain (single account):** `owner`, `name`, `URI`, `updateAuthority`, and **plugins**. Collection membership is expressed via `updateAuthority` being of type `Collection` → the collection pubkey.
- **Off-chain (at the `URI`, Candy uses Arweave):** `description`, `image`, `animation_url`, and `attributes` (the standard `trait_type` / `value` array), plus `properties.files`.
- **Relevant plugins:** **Royalties** (on-chain enforced — Candy's stated reason for choosing Core), **Edition / Master Edition** (numbered editions → edition number on-chain), **Attributes** (arbitrary on-chain key/value, string values only), Freeze/Transfer/Burn delegates.
- **Indexing path:** Helius **DAS** (`getAsset` / `getAssetsByGroup` / `getAssetsByOwner`) indexes everything — on-chain fields, plugins (incl. Attributes), and the resolved off-chain JSON. This is the same DAS path RPC's chain-two prebuild already targets.

Mapping Candy's specific fields (from the June 1 "new site" post + June 17 Base Series post):

- **On-chain serial numbers** — Candy states the product detail page shows "on-chain serial numbers." Serial is on-chain (Edition plugin and/or an on-chain Attribute). ✅ first-class.
- **Edition size** — shown "when applicable" (Master Edition max supply / attribute). ✅ where present.
- **Royalty enforcement** — on-chain via the Royalties plugin. ✅
- **Collection membership** — Core Collection via `updateAuthority`. ✅ (lets RPC group an entire Candy set by collection pubkey.)
- **Player attributes + live 2026 stats** (team, position, uniform number, "a snapshot of the season as it happens") — these are **dynamic/mutable** and most likely live in the **off-chain Arweave JSON** (updated by Candy's update authority), not as static on-chain attributes. This mirrors the AllDay consumer-GQL pattern: RPC would need a **metadata-fetch + refresh pipeline** to keep dynamic stats current, not just a one-time on-chain read.

**Decision input:** schema is **indexable and clean**. Static identity (serial, edition size, collection, royalty) is on-chain/structured; dynamic stats are Arweave JSON requiring a refresh pipeline. No show-stopper here.

---

## Probe 3 — Where will secondary trading actually happen?

**Finding: Magic Eden is the named, de facto secondary venue. Candy does NOT run its own order book. Tensor is a viable second source. Both have public APIs RPC can index. No verified Candy collection is live on either yet.**

- Candy's FAQ and blog repeatedly name **Magic Eden** as the supported secondary marketplace, "with more to be announced." Secondary is explicitly **off candy.io**.
- Magic Eden is the dominant Solana NFT marketplace (≈50% YTD share vs Tensor's ≈50% by recent volume splits; historically higher in some segments). **Tensor** is the co-leader and offers richer trader tooling (candlestick charts, listing-depth, volume histograms) — a good secondary data source.
- Both Magic Eden and Tensor expose public collection/stats/activities APIs (the standard Solana-NFT data path). This means RPC's chain-two ingest = **Helius DAS (editions/holders) + Magic Eden/Tensor API (listings/sales) + Arweave (media/dynamic metadata)** — confirming the prebuilt architecture.
- **Disambiguation caught:** the Magic Eden collection at `magiceden.us/marketplace/candies` ("Candies") is an **unrelated** Pixel-by-Pixel Studios pixel-art collection (artist Haizeel; floor ~0.24 SOL, ~2,695 supply, ~487 owners). It is **not** Candy Digital. Do not wire RPC to it. (Same class of trap as the unrelated NxGen `$CAND` token noted in prior research.)

**Decision input:** liquidity layer is clear (Magic Eden primary, Tensor secondary), both API-accessible. The only gap is that **Candy's collections aren't trading there yet** — so there's nothing to point an indexer at today.

---

## Probe 4 — Holder distribution

**Finding: Could not be measured. No verified, publicly discoverable Candy Digital Solana collection exists yet to snapshot. This absence is itself a finding and reinforces the lean-no-go.**

- Migration assets currently sit in **Candy-generated custodial wallets** whose private keys most fans have not yet revealed/exported to Phantom. They are not yet a browsable, liquid Magic Eden collection.
- No verified Candy collection address surfaced via search, Magic Eden, or Tensor. There is no reliable on-chain anchor (collection pubkey / candy-machine ID) to run a holder snapshot against.

What we *can* say about likely distribution shape, from primary sources (for context, not measurement):

- **2026 Base Series ICONs** structure (June 17 post): 100 players, Core-only, $10/pack, **10 ICONs per pack**, **9,990 packs total**, first drop just **500 packs**. Rainbow parallels at 1-in-16. Rares/Epics/Legendaries gated behind auctions/events.
- Historical 2023 MLB ICON structure: Legendary 1-of-1, Epic /40, Rare /100, ~2,350–5,001 NFTs per athlete — a **long-tail, retail-collector** shape, not a whale-only book.
- Candy's model (cheap $10 packs, pack-rip mechanics, set-collection quests, burn-for-credits "Diamond Economy") is structurally aimed at the **same retail collector profile** as RPC's Flow 100–2,000-asset cohort. If holdings track the product design, the cohort thesis **transfers** — but this must be **confirmed with a real holder snapshot on July 8**, not assumed.

**Decision input:** thesis-transfer looks plausible from product design, but is **unverified**. Re-run this probe against a real collection once one is liquid.

---

## Tripwire condition status (interim read)

| # | Condition | Interim status | Notes |
|---|---|---|---|
| 1 | ≥30 days of Candy Solana sales history | **At risk — likely won't clear by July 8** | Migration mid-rollout; secondary just opening for legacy assets; 2026 primary not on sale; no liquid collection discoverable. Clock hasn't cleanly started. |
| 2 | Defined edition/serial schema RPC can index | **Effectively clear** | Metaplex Core + on-chain serials + Collection grouping + Helius DAS + Magic Eden/Tensor APIs. Dynamic stats need an Arweave refresh pipeline. |
| 3 | Chain-abstraction Phases A–F complete | **Clear** | All phases A–F shipped by 2026-06-01 (per project record). |

---

## Blockers discovered

1. **No measurable Candy Solana data yet (primary blocker).** Two weeks past the June 8 *target*, there is no publicly discoverable, verified, liquid Candy collection on Magic Eden/Tensor, and primary 2026 sales are not live. Probes 2 (on-chain read) and 4 (holder snapshot) could not be executed against real Candy assets — not a tooling failure, but the genuine state of the rollout.
2. **The 30-day clock is mis-anchored in the checklist.** It assumes a June 8 open. The realistic anchor is the first day a verified Candy collection actually trades on a public Solana marketplace — which had not happened as of June 22. July 8 will very likely fall short of 30 days of meaningful volume.
3. **Dynamic-stat metadata needs a refresh pipeline.** The 2026 ICONs' live stats are mutable off-chain (Arweave) data, so RPC's FMV/intelligence layer would need a metadata-refresh path (AllDay consumer-GQL pattern), not just a one-time on-chain read. Not a show-stopper; a design note.
4. **No public Candy API** — confirmed, but this is *not* a blocker: the indexing path is on-chain + Magic Eden/Tensor, which needs no Candy partnership.

---

## Recommendation for the July 8 firm tripwire

1. **Expect Outcome #2 (defer), not Outcome #1 (go).** The schema and venue are ready; the *data* will not be. Plan for a 30–60 day deferral with the gate re-defined as "≥30 days of verified Candy secondary sales, measured from first live trading day."
2. **On July 8, first establish a verified anchor:** find the actual Candy Digital Solana **collection pubkey(s)** (via candy.io's migrated-asset detail pages, Magic Eden verified-collection listing, or Helius DAS by known creator/update-authority). Everything else depends on having a real anchor.
3. **Then re-run Probe 2 (real `getAccountInfo` / DAS `getAsset`)** against a confirmed Candy mint to verify on-chain serial/edition/collection/royalty exactly, and **Probe 4 (holder snapshot)** to confirm the 100–2,000 cohort empirically.
4. **Add Probe 5 (30-day sales volume)** per the checklist — but interpret against the true trading-start date, and expect a short, thin window.
5. **Hold all chain-two code.** Conditions #2/#3 being clear does not authorize starting chain-two implementation; condition #1 governs, per the strategy doc, and it is not met. No Solana code, no schema changes, no `lib/collections.ts` flips until Trevor green-lights post-July-8.

---

## Methodology & sources

**Tools:** WebSearch + web_fetch only (the sanctioned web tools). Primary sources preferred: Candy's own blog/FAQ, Metaplex Core developer docs, Magic Eden collection metadata. **No raw Solana RPC calls were made** — (a) no verified Candy mint address is publicly available to call, and (b) the documented Core model + Candy's own field descriptions were sufficient to characterize the schema. No production DB, no Chrome automation, no code.

Key sources:
- Candy — "Candy's New Site Is Live: What Fans Can Expect Today" (Jun 1, 2026): https://blog.candy.io/candys-new-site-is-live-what-fans-can-expect-today/
- Candy — "Candy Collectibles Migration to Solana: What Fans Need to Know" (Apr 29, 2026): https://blog.candy.io/candy-collectibles-migration-to-solana-what-fans-need-to-know/
- Candy — "A New Era Is Upon Us: Takeaways from Candy's Team X Space" (May 30, 2026): https://blog.candy.io/a-new-era-is-upon-us-biggest-takeaways-from-candys-team-x-space/
- Candy — "2026 MLB Base Series ICONs and the Diamond Economy" (Jun 17, 2026): https://blog.candy.io/2026-mlb-base-series-icons-and-the-diamond-economy/
- Candy — FAQ (revised May 2026): https://www.candy.io/faq
- Candy — marketplace splash ("New drops, Coming Soon"): https://www.candy.io/mlb/marketplace
- Metaplex — "What is a Core Asset" (on-chain vs off-chain, plugins, collection membership): https://www.metaplex.com/docs/smart-contracts/core/what-is-an-asset
- Metaplex — Attribute Plugin (on-chain key/value): https://www.metaplex.com/docs/smart-contracts/core/plugins/attribute
- Magic Eden — Solana market-share / dominance context: https://blog.magiceden.io/why-magic-eden-is-dominating-solana
- Magic Eden — "Candies" collection (CONFIRMED UNRELATED to Candy Digital — Pixel by Pixel Studios): https://magiceden.us/marketplace/candies
- CoinGecko — Solana NFT marketplace share (Magic Eden ≈ Tensor): https://www.coingecko.com/research/publications/top-nft-marketplaces

## What this audit deliberately did NOT do

Per the checklist's guardrails and standing project rules: no launch copy / tweets / Reddit / promo; no Solana code in the repo; no `chain_type` enum change; no production DB or cron touch; no brand/tagline or pricing decisions; no chain-two implementation proposal. Findings only.
