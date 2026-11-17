# Panini Prizm World Cup 2026 — pack-tracker data sourcing + RPC leverage

Date: 2026-06-25. Author: Cowork (Trevor-directed). Status: research — NOT a build.
Updates the Panini half of [docs/research/candy-panini-integration-research-2026-06-08.md](candy-panini-integration-research-2026-06-08.md).

Trigger: Trevor shared a community Google Sheet, "Panini Prizm World Cup 2026 — Pack Pull Tracker"
(`/spreadsheets/d/18UdHnbyslWGIK3iRzXBn2Ssjf5PGH6JgCKoJG4KSCIU`), and asked (a) how the data is pulled
and (b) how RPC can leverage it to build the Panini segment once we go live.

---

## TL;DR

- The sheet tracks **Panini Blockchain's** digital "2026 Panini Prizm FIFA World Cup" product — a live, on-platform
  digital trading-card release (NOT the physical Prizm WC product, though they share the checklist/parallel ladder).
- It is **pack-EV / pack-reality / squeeze intelligence by hand** — the exact thing RPC already does for Top Shot.
- "Cards still in packs" is **not scraped from a chain**. It's `mint_cap − cards_already_pulled`, derived from the
  **per-edition circulation count** the platform exposes. Verified against the sheet's own math (Messi 433 / 804 = 54%).
- The prior note that Panini is "private Sawtooth, un-indexable" is **too pessimistic**. Three live data planes exist
  (Panini marketplace API, CryptoSlam, Ethereum/OpenSea bridge). The soccer/FIFA license is clearly active.

---

## 1. What the product is (verified)

Panini Blockchain (`nft.paniniamerica.net`) dropped the digital **2026 Panini Prizm FIFA World Cup** set. Pricing is in
USD; the wallet/blockchain complexity is hidden behind a consumer marketplace (primary + secondary). All 48 nations.

Pack structure (Panini blog, reconciles exactly with the sheet):

- **FOTL packs** — 13,960 @ **$150**, dropped **Jun 19 2026** 10am CST. 5 cards: 2× Base Silver (/259), 1× non-Silver
  base parallel (max /124), 1× non-Silver **or** 35% chance insert (max /49), **+ 1 FOTL-exclusive parallel**.
- **Hobby packs** — 50,480 @ **$25**, dropped **Jun 24 2026** 10am CST. 4 cards (2 Silver, 1 non-Silver, 1 non-Silver/35% insert).
- **Base parallel ladder (per player):** Silver /259 · Red /124 · Blue /49 · Cracked Ice /25 · Gold /10 · Zebra /5 · Black 1/1.
- **FOTL-exclusive parallels:** Aguila /11 · Maple Leaf /9 · Old Glory /7 · Nebula 1/1.
- **Tiered inserts** (/49 Silver, /10 Gold, 1/1 Black): Scorers Club, New Era, Connections, Aces, Phenomenon, Global Reach,
  Trophy Hunting, Screamers, National Landmarks, World Cup Posters, Team Badges.
- **Non-tiered inserts** (/25): Color Blast, Color Blast Duals, Prizmania, Color Wheel, Manga, National Pride, Alter Ego.
- Plus craft-pack events + rainbow challenge-reward parallels (Pink Wave, Rattlesnake, Genesis, Tiger Stripe) minted via challenges.

## 2. How the tracker pulls the data (the answer)

The sheet is one snapshot per edition (parallel × player), timestamped and refreshed by hand
(community-sourced — Discord, credited "SingaporeTexan"). Two derived numbers per cell:

- **Total Mint** = the edition's fixed serial cap (a published product fact — /259, /124, /49, …).
- **Cards still in packs** = `mint_cap − cards_already_pulled`, where "pulled" = the platform's **per-edition circulation
  count** (how many of that numbered card have been opened out of packs into wallets). As packs are ripped, circulation
  rises, so "still in packs" falls — which is why the column decreases between snapshots.

Everything else is arithmetic on those two columns + the known pack counts:

- `% in packs = still_in_packs / mint_cap` (verified: Messi 433 / 804 = **54%**).
- Pack odds `1:N` and FOTL rip-% are computed from caps ÷ pack counts (e.g., Aguila 1:60 ≈ 13,960 FOTL packs ÷ ~233 Aguila).

Where the per-edition circulation count comes from — two exposed sources, both verified to exist:

1. **Panini's own marketplace** (`nft.paniniamerica.net`) — authoritative. It's a JavaScript SPA (reCAPTCHA-gated) backed by
   JSON endpoints; every card page shows `owned# / total_minted`. The sheet uses the **official Prizm parallel names**
   (Silver/Red/Blue/Cracked Ice…), which match the marketplace — so the sheet is most likely scripted/collected against
   Panini's marketplace search/checklist endpoint. (Could not capture the exact endpoint — it's behind reCAPTCHA/login;
   confirmed only that it's an SPA + backing API.)
2. **CryptoSlam** (`cryptoslam.io/panini-america`) — an **independent live index** of Panini Blockchain with Mints / Unminted
   ("still in packs") / Checklists / scarcity, per-card **with serials**, ~11h lag. **Verified its API directly** via browser
   network capture: `POST https://web-api.cryptoslam.io/v1/mints/Panini America/search` (+ `/nav`). CryptoSlam also sells a
   commercial **NFT API** (`cryptoslam.io/products/api`). Caveat: CryptoSlam's live feed currently shows a Panini soccer
   product under *different* parallel vocab (Field Level / Mezzanine / Gold Wave / Peacock / Honeycomb), so it covers Panini
   soccer live but is **not confirmed to be this sheet's exact source** — treat it as the ready-made alternative feed, not
   proof of provenance.

Net: the sheet author is doing, by hand/script, what RPC's pack pipelines do automatically — reading per-edition circulation
and computing residual pack supply.

## 3. Platform topology (verified)

- **Chain:** Panini Blockchain runs on private **Hyperledger Sawtooth** (permissioned; no public RPC → not directly indexable
  the way Flow is). The marketplace API is the practical primary-market/pack-state surface.
- **Ethereum bridge (opened Mar 30 2026):** collectors can **optionally, per-card** bridge to ETH mainnet, where cards become
  standard ERC NFTs with metadata/media on decentralized storage, tradeable on **OpenSea** (`opensea.io/collection/paniniblockchain`).
  Reversible. This is the only **fully public/on-chain** surface — but it's the *bridged subset only*, and a brand-new set may
  not be bridge-enabled at launch.

## 4. RPC leverage plan

RPC state today: `collections` row `panini_blockchain` (UUID `d1a0a7f5-609a-49f4-a1a7-4eaac55b020b`, `chain=ethereum`,
`is_active=false`, `contract_address` NULL). The "un-indexable" framing should be relaxed — there are three live planes:

| Plane | Source | Gives | Watch-outs |
|---|---|---|---|
| Primary / pack-state | Panini marketplace JSON API | edition catalog, per-edition circulation, pack inventory, primary+secondary listings | reCAPTCHA + likely login; unofficial → needs a proxy (topshot-proxy pattern); ToS/WAF risk |
| Index / shortcut | CryptoSlam `web-api.cryptoslam.io/v1` + commercial NFT API | live mints/unminted/serials/scarcity for all Panini | 3rd-party dependency; ~11h lag; verify it carries the exact Prizm set |
| Secondary / on-chain | Ethereum + OpenSea (`/collection/paniniblockchain`) | real on-chain secondary sales/FMV of bridged cards | bridged subset only; newest set may not be bridge-enabled yet |

The sheet maps 1:1 onto surfaces RPC already builds for Top Shot:

- **Pack EV / Pack Reality** — gross/net EV per $150 FOTL & $25 Hobby pack; chase hit-rates; "is this +EV right now?".
- **Squeeze board** — "cards still in packs" → effective supply / scarcity as packs drain. This is literally RPC's squeeze
  concept applied to pack residual instead of lock+burn.
- **FMV per parallel, serial-aware** — cards carry serials (`32/49`); reuse the FMV + serial-FMV engines.
- **Special serials / trophies** — #1, perfect last-mint, the 1/1 Black & Nebula chases.
- **Entity pages + checklists** — player / parallel / set hubs, same system as Flow collections.

Concrete steps for "when ready" (do NOT start now — see §5):

1. **Discovery.** Capture the Panini marketplace's backing JSON endpoint(s) on a logged-in card/market page (the per-edition
   circulation call), and pull the OpenSea/ETH **contract address(es)** from the collection page / Etherscan → fills
   `contract_address`. Define the edition/serial schema from the parallel ladder above.
2. **Secondary plane.** Stand up an EVM indexer for the bridged collection — reuse the existing Beezie/Base `evm_*` registry
   pattern — for on-chain secondary sales/FMV.
3. **Primary plane.** Pick the pack-state feed: Panini marketplace API behind a proxy (highest fidelity) and/or CryptoSlam's
   NFT API (fastest; backstop). Ingest editions + circulation + pack inventory.
4. **Surfaces.** Light up Panini pack-EV + squeeze + FMV by reusing the Top Shot machinery.

## 5. Caveats / honesty

- **Verified:** product + pack facts (Panini blog ↔ sheet reconcile exactly); the still-in-packs arithmetic; Sawtooth + the
  Mar-30 ETH/OpenSea bridge; CryptoSlam's live Panini index + its `web-api.cryptoslam.io/v1/mints` endpoint (captured directly).
- **Not verified / inferred:** the exact Panini marketplace endpoint (reCAPTCHA/login-gated — SPA + backing API confirmed,
  URL not captured); that CryptoSlam is *this* sheet's source (vocab differs → likely Panini marketplace instead); the live
  WC2026 set's ETH contract address (collection exists; address not pulled).
- **Strategy guardrail:** RPC's rule is **one chain at a time, never parallel**. Chain two = Candy/Solana is the current focus.
  Treat Panini-soccer as a *sequenced* IP expansion; this research de-risks it (data is pullable, license active) but does not
  greenlight a parallel build.

---

## 6. Implementation blueprint (grounded in live RPC schema, verified 2026-06-25)

Verified DB state this session (read-only):

- `collections` row `panini_blockchain` — `id d1a0a7f5-609a-49f4-a1a7-4eaac55b020b`, `chain=ethereum`, `is_active=false`,
  `contract_address=NULL`. Inert and ready.
- **A generic multi-chain EVM NFT indexer already exists** and is the drop-in template for the bridge plane:
  - `evm_chains` — Flow EVM Mainnet (chain_id 747) + Base Mainnet (8453), both active. **Ethereum mainnet (chain_id 1) is NOT registered yet.**
  - `evm_nft_contracts` — `(chain_id, contract_address, label, start_block, is_active)`; one row today = `beezie_collectibles` on Base.
  - `evm_indexer_cursors` · `evm_nft_transfers` (month-partitioned: `chain_id, contract_address, token_id, from_address, to_address, block_number, log_index, transaction_hash, block_timestamp`) · `evm_nft_current_owners` · `evm_nft_transfers_unresolved`.

Two-plane ingest, mirroring RPC's existing Flow + Beezie/Base split:

### Plane A — Primary / pack-state (the differentiator)

Source: Panini marketplace API and/or CryptoSlam commercial NFT API. Feeds the edition catalog + per-edition **circulation** +
**pack inventory** + listings — the data the sheet pulls by hand.

- `collections.panini_blockchain` already exists → flip `is_active=true` at go-live **only**.
- **Editions:** evaluate generic `editions` vs a dedicated **`panini_editions`** side-table. Pinnacle set the precedent
  (`pinnacle_editions`) when a collection's parallel/insert schema diverges — and Panini's does (base ladder + FOTL-exclusive
  parallels + tiered/non-tiered inserts + challenge rewards). Carry: external_id, player, parallel, rarity tier,
  **circulation_count = mint cap**, **minted/pulled count**, FOTL-exclusive flag, set/insert name, serial, art.
- **"Still in packs" = mint_cap − pulled** → store + refresh per edition. This is the squeeze input and the headline feature.
- **FMV:** own `algo_version` (or a `panini_fmv_snapshots` table, per the Pinnacle precedent — Pinnacle FMV lives outside the main `fmv_snapshots`).
- **Packs:** `pack_distributions` / `pack_drop_pool` / pack-EV — FOTL ($150 × 13,960) + Hobby ($25 × 50,480) with the documented slot odds.

### Plane B — Secondary / on-chain (bridged subset) — reuse the `evm_*` indexer wholesale

Additive, no new architecture:

1. `evm_chains` ← register **Ethereum mainnet** (chain_id 1, RPC URL, explorer). (Indexer needs an ETH RPC configured — new infra cost to weigh.)
2. `evm_nft_contracts` ← `(chain_id 1, contract_address=<panini bridge>, label='panini_blockchain', start_block=<bridge deploy>, is_active)`.
3. Existing indexer walks Transfer logs → `evm_nft_transfers`; bridge to RPC `sales`/`editions` by `(contract, token_id)`
   (the documented "bridge evm_nft_transfers into editions" path), price-enriched from the marketplace / OpenSea.

Caveat: only the optionally-bridged subset, and the brand-new WC2026 set may not be bridge-enabled yet → **Plane A is the
real-time source; Plane B backfills on-chain provenance + secondary sales for bridged cards.**

### Surfaces (reuse Top Shot machinery 1:1)

- **Pack EV / Pack Reality** — gross/net EV per $150 FOTL & $25 Hobby pack; chase hit-rates; "+EV right now?".
- **Squeeze board** — "cards still in packs" → effective supply as packs drain. The sheet's whole point; our exact concept.
- **FMV per parallel, serial-aware**; **special serials / trophies** (#1, perfect last-mint, 1/1 Black & Nebula).
- **Entity pages + checklists** — player / parallel / set hubs.

### Rollout — inert-first, sequenced (the Candy precedent)

The 2026-06-08 Candy onboarding is the template for "build ahead without going live": seed inert rows, ship ingest gated
behind discovery TODOs, no cron/watchlist, write for one `collection_id` only. Do the **same** for Panini — but **do not start
it as a parallel build**. The strategy rule stands: one chain at a time, Candy/Solana is chain two. Panini is a *later*
sequenced expansion; this blueprint + the discovery items below make it a fast start when its turn comes.

### CryptoSlam note (verified)

CryptoSlam's public feed is a .NET + MongoDB DataTables endpoint (`web-api.cryptoslam.io/v1/mints/Panini America/{nav,search}`).
The `nav` facets lag (no "2026" season yet) but the live mints feed already carries 2026 Panini soccer at per-card serial
granularity (~11h lag). For RPC, use their **commercial NFT API** (`cryptoslam.io/products/api`) as Plane A's fast path /
backstop rather than scraping the internal endpoint.

### Open discovery items (one-time; blocked from this environment)

1. Capture the Panini marketplace's per-edition circulation/pack JSON endpoint (reCAPTCHA/login-gated; SPA + backing API confirmed).
2. Pull the bridge **contract address + chain_id** from OpenSea / Etherscan (both blocked by this browser's safety list) →
   fills `collections.contract_address` + the `evm_nft_contracts` row.
3. Decide `editions` vs a `panini_editions` side-table (lean side-table, per Pinnacle).
4. Price CryptoSlam's commercial NFT API vs a marketplace-scrape-via-proxy (topshot-proxy pattern) for Plane A.
