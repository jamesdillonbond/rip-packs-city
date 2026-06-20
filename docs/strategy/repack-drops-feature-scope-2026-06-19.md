# Re-Pack (Curated Pack Drops) — Feature Scope & Build Spec

**Date:** 2026-06-19
**Author:** Cowork investigation (reverse-engineered from the live Vaultopolis mainnet contract)
**Status:** Scoping only — nothing built. Decision doc + pick-up-ready spec for a future build.

---

## 1. TL;DR

Vaultopolis's "Drops / early-access packs" (e.g. `vaultopolis.com/early-access/4`) is a **curated re-pack product**: the operator buys real Top Shot moments, bundles them into sealed packs with published odds, and sells the packs for FLOW. It is **separate** from their flagship TSHOT vault.

**The whole thing runs on one custom Cadence NFT contract** — `VaultopolisPacks` at `0x9044559cc75cddc5` — that uses a **SHA2-256 commit-reveal** for provable fairness. **There is no on-chain randomness in it** (0 references to VRF/RandomBeacon). The "odds" are pure operator curation; the commit-reveal only proves the operator can't swap your pack's contents after you buy.

**Can RPC replicate it?** Technically yes, comfortably — it's standard Cadence + a backend RPC already has the muscle for, and RPC's pack-EV/FMV engine would let us price packs *more honestly* than they do. **But it is the same strategic fork as Cart and Trade Hub** (both shelved): it turns RPC from *intelligence about the market* into *a market participant that holds inventory and custodies value*. That decision — capital + custody risk + ToS exposure — is the real gate, not the engineering.

**Recommendation (non-binding):** if/when we want this, ship **Phase 0 (the intelligence wedge)** first — it's days of work, zero custody, and fits intelligence-first. Treat the full re-pack product (Phases 1–4) as a deliberate business-model decision to make only after 50+ WAU and an explicit choice to hold inventory.

---

## 2. Reference architecture (how Vaultopolis actually does it)

### 2.1 The contract

`VaultopolisPacks` @ `0x9044559cc75cddc5` (Flow mainnet, Cadence). ~24 KB. Standard `NonFungibleToken` implementation. Imports only:

- `NonFungibleToken`, `MetadataViews`, `ViewResolver` @ `0x1d7e57aa55817448`
- `FungibleToken` @ `0xf233dcee88fe0abe`

(No randomness contract imported. Confirmed: 0 `Random*` references.)

A sibling contract `TokenWrapper` lives on the same account (an NFT wrapper with a `redeem` path) — adjacent, not core to packs.

### 2.2 Resources

- `Pack` — represents a sealed pack
- `NFT` — the pack token a buyer holds
- `Collection` — standard NFT collection
- `VaultopolisPacksOperator` (+ `IOperator` interface) — admin/operator authority

### 2.3 Functions (exact params, read from chain)

| Function | Params | Role |
|---|---|---|
| `createDrop` | `dropId, name, description, externalURL` | Operator registers a drop's metadata |
| `mint` | `dropId, commitHash, issuer` | Mints a sealed pack NFT carrying a SHA2-256 commitment to its hidden contents |
| `reveal` | `id, nfts, salt` | Reveals contents; contract checks `SHA2_256(salt ++ nfts) == commitHash` |
| `open` | `id, nfts` | Delivers the revealed moments to the holder |
| `verify` | `nftString` | Public verification helper |
| `lockDrop` | `dropId` | Freezes a drop |
| `setDropArt` / `setArt` | — | Cosmetic |

### 2.4 Events (the lifecycle, in order)

```
DropCreated(dropId, name) → DropLocked(dropId)
  → Minted(id, hash, dropId)           // sealed pack minted w/ commitment
  → [sold for FLOW via NFTStorefront]
  → RevealRequest(id, openRequest) → Revealed(id, salt, nfts)   // commit opened
  → OpenRequest(id) → Opened(id)        // moments delivered
  → Burned(id)                          // empty pack NFT destroyed
```

### 2.5 The model in one paragraph

The operator composes a drop **off-chain**: pick N moments, lay them into P packs by a slot template, assign value tiers, compute each pack's `commitHash = SHA2_256(salt ++ orderedNftList)`. On-chain, `createDrop` + `mint` produce P sealed pack NFTs that carry only the hash — contents hidden. The packs are **sold for FLOW via Flow's standard `NFTStorefront`** (that's why the frontend references NFTStorefront/FlowToken, not a custom payment path). After buying, the holder calls `reveal` (publishes salt + nft list; anyone can `verify` the hash matches → provable the contents were fixed at mint) then `open` (the real Top Shot moments are delivered from the issuer/treasury, pack burned).

**Key insight:** the "randomness" a buyer feels is just *which identical-looking sealed pack they bought*. Allocation is operator/marketplace-ordered, **not** VRF. The commit-reveal is an **integrity** guarantee (no per-buyer swap), not a fairness-of-draw mechanism. (Contrast: their TSHOT vault `TSHOTExchange` @ `0x05b67ba314000b2d` **does** use real Flow VRF via `RandomConsumer` + a `Receipt` resource — different product, different guarantee.)

### 2.6 Inventory model (one open question)

`mint` takes a `commitHash` + `issuer`, and `open` takes the `nfts` list — which suggests the moments are **held in the issuer/treasury account** and matched to the pack at open, rather than physically escrowed inside each `Pack` resource. RPC could choose either:

- **Treasury-held (Vaultopolis-style):** simpler, but the buyer trusts the issuer still holds the moments until open.
- **Escrow-in-pack:** the `Pack` resource literally holds the moment NFTs from mint. More trustless (contents are on-chain-verifiable pre-open), slightly more contract complexity. **Recommended for RPC** — it's a cleaner story and a differentiator.

### 2.7 The economics (from drop #4, "Vaultopolis Finals Pack")

- 15 packs × 3 moments = 45 real TS moments; 170 FLOW (~$4.79)/pack
- Pool est. value ~$104; gross-if-sold-out ~$72 → **sold below pool value** (a traction/loss-leader play, viable because their TSHOT vault sources commons cheaply)
- Value concentrated in one chase (Wemby parallel ~$23) + 5 rares (~$5.58–8.50); 39 commons avg ~$1.17
- Classic pack math: mean EV > price, median pack < price.

The off-chain drop metadata is served from an **open, unauthenticated backend**: `data.vaultopolis.com/api/drops/{id}/{composition,odds,sale-state}`. Trivially indexable.

---

## 3. Two product shapes RPC could build

### Shape A — Intelligence wedge (fits current strategy, ship anytime)

Index Vaultopolis (and any future copycat) drops, score each pack's **true EV against RPC FMV**, and publish a public `/insights/pack-drops` board: "is this drop worth it," value concentration, per-tier honesty check (their hand-assigned `valueTier` vs our computed FMV), sell-through. No inventory, no custody, no contract. Pure intelligence — the exact RPC moat. **This is the recommended first move regardless of whether we ever build Shape B.**

### Shape B — Full re-pack product (the strategic fork)

RPC mints and sells its own curated packs. The rest of this doc specs Shape B so it's pick-up-ready. **Do not start Shape B without an explicit decision to (a) hold moment inventory and (b) operate an on-chain custody/sale system** — see §6.

---

## 4. Build spec — Shape B (full re-pack product)

### 4.1 On-chain: `RPCPacks` Cadence contract

Mirror `VaultopolisPacks`, RPC-flavored, **escrow-in-pack** variant.

Resources:
- `Pack` — escrows the 3 (or N) Top Shot moment NFTs + stores `dropId`, `commitHash`, `tierTemplate`
- `NFT` — the pack token (standard `NonFungibleToken.NFT` + `MetadataViews` so it renders in wallets/marketplaces)
- `Collection`
- `Operator` (admin resource, RPC-controlled) — `createDrop`, `mintPack`, `lockDrop`

Functions:
- `createDrop(dropId, name, description, externalURL, slotTemplate)`
- `mintPack(dropId, commitHash, moments: @[NFT])` — escrows the moments, emits `Minted`
- `reveal(id, nfts, salt)` — `assert SHA2_256(salt ++ nfts) == commitHash`
- `open(id)` — withdraw escrowed moments to `self.owner`, burn pack
- `verify(nftString, salt, hash): Bool` — public, stateless (powers the verify page)

Provable fairness recipe (publish this):
```
commitHash = SHA2_256( salt(32 bytes) ++ utf8( JSON(sortedMomentIds) ) )
```
Optional upgrade — **true VRF allocation**: if we want the *draw* itself trustless (not just the contents), add Flow's native randomness (`RandomBeaconHistory` / `RandomConsumer`, commit-reveal `Receipt` pattern, exactly like `TSHOTExchange`). Vaultopolis chose not to; doing so would be a genuine "more provably fair than Vaultopolis" differentiator. **Verify the current mainnet randomness contract addresses via the Cadence MCP before writing — do not trust training data.**

Cadence discipline (from CLAUDE.md): Cadence 1.0 (`auth(BorrowValue) &Account`), verify every contract/struct field against the live deployment via the Cadence MCP, route all production reads through the existing worker proxies. Unit-test on testnet with the `flow test` harness (CI already gates `cadence-lint`).

### 4.2 Sale rail

Reuse Flow's `NFTStorefrontV2` (Dapper) @ `0x4eb8a10cb9f87357` — list each sealed pack NFT for FLOW; no custom payment code. (RPC already decodes this storefront in the sales indexers, so the read side is familiar.) Buyer purchases the pack NFT via standard Storefront, then `reveal` + `open`.

### 4.3 Backend (Supabase — RPC already has all of this)

New tables (RLS on, anon SELECT-only, writes service-role via SECDEF — follow the `rpc-migration` skill + the public-table RLS/grant checklist):

- `pack_drops` — `drop_id, name, description, slot_template jsonb, status, pack_count, nfts_per_pack, published_at, locked_at, art_url`
- `pack_drop_units` — one row per sealed pack: `drop_id, pack_nft_id, commit_hash, salt (kept secret until reveal), status (minted/listed/sold/revealed/opened), buyer_address`
- `pack_drop_moments` — `drop_id, pack_nft_id, moment_nft_id, value_tier, slot_index, pulled bool` (value_tier = RPC-computed, not hand-assigned)
- `pack_drop_orders` — order/refund tracking around the Storefront purchase + reveal

API routes (mirror Vaultopolis's open API, but ours is FMV-backed):
- `GET /api/public/drops/[id]/composition|odds|sale-state` (public, cached)
- `POST /api/admin/drops/create|mint|lock` (RPC_ADMIN_TOKEN-gated, like `/admin/flowty-analytics`)
- reveal/open are client FCL transactions; backend just records events

Cron/observability: a pipeline to watch `Minted/Revealed/Opened` events and reconcile `pack_drop_units.status`; log to `pipeline_runs`; add to `pipeline_cadence_watchlist`.

### 4.4 Pricing & composition engine (RPC's real edge)

This is where RPC beats Vaultopolis. Reuse the existing **pack-EV engine** (`compute_pack_ev_*`, `pack_ev_*` views) and **FMV** (`fmv_snapshots` / `get_fmv`) to:
- compute each pack's true EV at composition time and **price at/below EV** (traction play, consistent with "no paywall until traction")
- assign `value_tier` from **computed FMV**, not a hand guess
- publish honest per-pack EV + value-concentration on the drop page (no one else does this)
- run the squeeze/rookies/trophy signals to theme drops around genuinely scarce moments

### 4.5 Frontend

- `/drops` index + `/drops/[id]` drop page (composition grid, fixed-odds table, EV/honesty panel, FLOW price, sale-state)
- Buy (FCL → Storefront), Reveal, Open, **public Verify page** (paste pack id → recompute hash → show it matches; our verify page should be a first-class trust feature)
- "My Packs" (sealed/revealed/opened) + Activity
- Brand tokens (`var(--rpc-red)`, `var(--font-display)`), dashboard chrome, `proxy.ts` public-path carve-outs for the public drop/verify routes only.

### 4.6 Treasury / inventory

- A dedicated, well-secured **treasury account** holding the moments to repackage. **Do not reuse the existing hot wallet `0x3aa11c84d776838f` or any HybridCustody/linked wallet for custody of user-bound inventory** (CLAUDE.md hot-wallet rule). New key management + a security review.
- Re-fund and un-pause the Cadence **payer wallet `0x73f55c4450b8d466`** (currently intentionally empty, `cadence-payer-balance-check` cron paused) — every pack mint/open is a gas-paying Cadence write.
- Sourcing: floor-sweep commons + a chase per theme. Track cost basis so we know real margin (RPC's FMV makes this exact).

---

## 5. Effort estimate & reuse

| Phase | Scope | Rough effort (solo) |
|---|---|---|
| **0** | Intelligence wedge: index Vaultopolis drops, EV/honesty board `/insights/pack-drops` | 2–3 days |
| **1** | `RPCPacks` contract + testnet deploy + `flow test` unit tests + commit-reveal verify | 3–5 days |
| **2** | Treasury setup, admin drop tooling (createDrop/mint/lock), off-chain composition + hashing, inventory sourcing | 3–4 days |
| **3** | Sale rail (Storefront), drop/buy/reveal/open/verify UI, My Packs, backend tables + routes + reconcile cron | 5–7 days |
| **4** | Mainnet deploy, external security review, soft launch to allow-list | ongoing + review lead time |

Core engineering for Shape B ≈ **3–4 focused weeks**, **plus capital for inventory** and a security review. Most of the *supporting* stack is already built and reusable:

**Reuse map:** FCL + the worker proxy layer · `NFTStorefrontV2` decode (sales indexers) · pack-EV engine (`compute_pack_ev_*`) · FMV (`fmv_snapshots`, `get_fmv`) · `editions` / `wmc` · Supabase + cron + `pipeline_runs`/watchlist · the `/admin/*` RPC_ADMIN_TOKEN gate · brand system · `proxy.ts` public-path pattern · the `rpc-migration` / `rpc-insights-qa` / `rpc-handoff` skills. Cowork can ship the DB migrations live; **all contract/route/.tsx lands via a Claude Code handoff** (Cowork can't push code).

---

## 6. Risks & open decisions (the real gate)

1. **Business-model fork.** Same class as Cart (shelved) and Trade Hub (shelved, escrow undeployed). RPC is committed intelligence-first; this makes us a market participant + custodian. Decide deliberately.
2. **Capital.** You must own inventory. Money tied up in a moment treasury, with price risk.
3. **Custody & security.** Holding users' would-be moments + taking FLOW = a hot, value-bearing system. Needs key management + an external Cadence security review before mainnet.
4. **ToS / "gambling-adjacent."** Selling randomized packs with published odds carries disclosure obligations and possible Dapper-ToS / regulatory exposure. Worth a legal read (mirror the rewards-raffle legal-review caution).
5. **Dapper relationship.** We have a constructive relationship; a competing pack product on their moments is a relationship question, not just a tech one.
6. **Gas/ops.** Re-funding the payer wallet, fulfillment, refunds, support — ongoing operating load.
7. **Monetization timing.** Holds behind the "no monetization until 50+ WAU and the product works" line.

---

## 7. If we never build Shape B

This doc still pays for itself:
- **Competitive intel:** we now know their exact mechanism (commit-reveal integrity, no VRF, off-chain curation, open API, below-pool pricing fed by the TSHOT vault).
- **Shape A is a free win:** an FMV-backed "is this drop worth it" board indexes their open API today, no custody — pure RPC moat, and a reason for their buyers to come to us.

---

## 8. Source of truth

Read live from Flow mainnet on 2026-06-19:
- `VaultopolisPacks` @ `0x9044559cc75cddc5` (functions, events, resources, SHA2-256 commit-reveal, zero randomness — confirmed)
- `TSHOTExchange` @ `0x05b67ba314000b2d` (the vault's real VRF, for contrast)
- Open drop API: `data.vaultopolis.com/api/drops/4/{composition,odds,sale-state}`
- UI: `vaultopolis.com/early-access/4`

_End of scope doc._
