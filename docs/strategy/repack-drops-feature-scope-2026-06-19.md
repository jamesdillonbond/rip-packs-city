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

---

## 9. Feasibility verdict for RPC — custody, rail & market (2026-06-20 research)

The build (§4) is the easy part. RPC-specific feasibility comes down to **the Dapper custody wall** — the exact thing that shelved Cart — so the key finding is: **packs run on a different rail than Cart did, and that rail is permissionless.**

### 9.1 Why this is NOT the Cart blocker

Cart was shelved because buying a Top Shot **native marketplace** listing settles in **DUC from a Dapper-custodial balance**, which needs the **Dapper dual co-signer** + "Sign in with Dapper" (Dapper developer access — still pending). Packs avoid all three:

- **Payment rail = FLOW via `NFTStorefront`** (verified: UI prices in FLOW; the contract/frontend reference `NFTStorefront` + `FlowToken`, never DUC or the Dapper merchant address). A FLOW Storefront purchase is a **standard single-signer FCL transaction** — the buyer signs alone. No Dapper co-signer.
- **Delivery (depositing a moment to a buyer) is permissionless** on Flow — any account's TopShot collection exposes a public deposit receiver, so RPC can deliver the pulled moment to **anyone**, including a fully Dapper-custodial collection. Delivery is not the constraint.
- **Treasury sourcing** (RPC acquiring moments to repackage) is just RPC buying moments into its own self-custody account — permissionless.

> Confidence: high, but based on the contract + frontend + how Flow Storefront/FLOW works, not a traced historical buy tx (the explorer wouldn't render). Worth a 10-minute on-chain confirmation of one real pack buy's signer set before committing.

### 9.2 Where the Dapper wall still touches it — and RPC already has the key

The one place custody matters is **moving a moment OUT of a Dapper-custodial account** (relevant if a *buyer* wants to pay/trade using assets locked in Dapper, or for any deposit-into-treasury-from-Dapper flow). The permissionless answer is **Flow Account Linking / Hybrid Custody**: a user links their Dapper child account to a self-custody parent (Flow Wallet/Blocto/Dapper self-custody), after which the parent can sign for the Dapper-held assets — **no Dapper partnership required**.

**RPC already built these primitives** (May 2026): the `hybrid-custody-proxy` worker against HybridCustody `0xd8a7e05a7ac670c0`, the `linked_accounts` table, `get_linked_parents/children/all`, and `resolve_canonical_owner`. So the hardest custody piece is partly pre-built.

### 9.3 The real ceiling = the addressable market, not the tech

To **buy** a pack, a user must sign a FLOW Storefront purchase — i.e. hold a **FLOW-funded, FCL-signable wallet** (self-custody or linked; cleanest is Flow Wallet/Blocto/Dapper-self-custody). The casual Top Shot majority sits in **Dapper-custodial wallets with no FLOW and no self-custody setup** and cannot buy without onboarding first. That's the same wall RPC's own verification already lives behind (listing-challenge for self-custody; Sign-in-with-Dapper pending).

So the participating market ≈ the **engaged self-custody / linked minority that holds FLOW** — which is *exactly RPC's stated target cohort* (100–2,000-moment serious collectors), but it's thousands, not the whole user base. **Demand ceiling, not a tech blocker.**

### 9.4 Feasibility scorecard

| Dimension | Rating | Note |
|---|---|---|
| Cadence contract (`RPCPacks`) | **Easy** | ~24 KB, standard patterns, mirrors a working reference |
| Backend / API / FMV-EV pricing | **Easy** | RPC already has every piece |
| Payment rail (FLOW Storefront) | **Easy** | Single-signer; no Dapper co-signer (unlike Cart) |
| Moment delivery | **Easy** | Public deposit — works to any collection, even Dapper-custodial |
| Buyer-side custody (move Dapper assets) | **Medium** | Account-linking UX; primitives already built |
| Treasury, gas, security review | **Medium** | Re-fund payer wallet `0x73f55c4450b8d466`; external Cadence audit before mainnet |
| Addressable market | **Hard-ish** | Self-custody + FLOW gate caps near-term demand |
| Inventory capital + strategy fit | **The gate** | Holding inventory = the Cart/Trade-Hub business-model fork |

**Bottom line:** technically **more feasible than Cart** — the FLOW + Storefront + account-linking rail is permissionless and RPC already owns the hard custody primitives. Feasibility is **not blocked by Dapper**. The binding constraints are, in order: (1) the deliberate decision to hold moment **inventory** (capital + the intelligence-first fork), (2) the **small self-custody+FLOW market** near-term, (3) **custody/security ops** (treasury keys, audit, refunds, gas), (4) **ToS/“gambling-adjacent”** review. None are engineering walls.

### 9.5 Cheapest way to de-risk before any contract work

1. **Confirm the rail** — trace one real Vaultopolis pack buy on-chain; verify single-signer FLOW Storefront, no Dapper co-sign. (~10 min)
2. **Ship Shape A** (the FMV "is this drop worth it" board) — zero custody, proves demand + draws their buyers to RPC.
3. **Measure the market** — from RPC's own data, count tracked wallets that are self-custody/linked AND FLOW-funded. That number *is* the pack TAM; it decides whether Shape B is worth the capital.
4. Only then deploy `RPCPacks` to **testnet** and dry-run a 1-pack drop to yourself.

---

## 10. Phase-0 evidence — executed live 2026-06-20

Ran the §9.5 de-risk steps against RPC's own warehouse (`bxcqstmqfzmuolpuynti`) and the live drop. Real numbers below.

### 10.1 Pack TAM (measured)

- **RPC tracked wallets (wmc): 261** — 92 in the 100–2,000 target cohort, 158 whales (>2,000), 11 under 100. (This is RPC's *seeded* population, not the market.)
- **Account-linked / Hybrid-Custody wallets RPC has indexed: ~66** (70 link rows / 69 parents / 66 children) — the definitively self-custody-capable signal, and it is **tiny**.
- **Active on-chain TS buyers RPC indexes: 3,655 in 90d, 7,463 all-time** — the broad ceiling, but most transact via Dapper/DUC (not FLOW), so this overstates the pack market.
- **Read:** the near-term pack-buying market is the self-custody/linked slice — tens to low hundreds today (Vaultopolis itself reports ~300 active users), **not** the 3,655 broad buyers. This confirms §9.3: the binding constraint is the demand ceiling, not the tech. The metric to grow before committing to Shape B is "linked/self-custody + FLOW wallets," and RPC already has the `linked_accounts` sensor to track it.

### 10.2 RPC-priced EV of the live drop — Shape A proof-of-concept (works today)

Cross-referenced all **45 moments / 14 distinct editions** of "Vaultopolis Finals Pack" against RPC FMV. RPC auto-priced **13 of 14** editions straight from existing data:

- **RPC-priced pool: $123.85** vs Vaultopolis's stated **$104.17** (RPC ~19% higher).
- **RPC pack EV: $8.26** vs Vaultopolis's $6.94 — both far above the **$4.79** price. Independent confirmation the packs are EV-positive.
- **RPC disagrees usefully:** values OG Anunoby "Metallic Gold LE" at **$17 (MEDIUM)** vs Vaultopolis's hand-assigned **$8.50** — catches their underpricing of a rare. Several commons also price above their $1 floor.
- **One exposed RPC gap:** the Wemby **parallel** chase (#73, ~$23). RPC's *edition-level* FMV prices the base edition (~$2.66), not the parallel/subedition — so RPC currently **undervalues the single most valuable card**. This is exactly the serial-/parallel-FMV layer RPC is already building; fixing it pushes the RPC valuation higher still. (RPC's pool still beat Vaultopolis's *despite* this.)
- **Takeaway:** Shape A is buildable on existing RPC data **today** (13/14 auto-priced) and already surfaces value the operator's own numbers miss. The validated SQL is in the build handoff (`docs/handoff-2026-06-20-pack-drops-intel-board.md`).

### 10.3 On-chain rail — still inferred, not tx-traced

Could not trace a single live buy tx: Vaultopolis's activity endpoints 404, the explorer SPA wouldn't render, and walking sparse Flow events is too costly. The §9.1 conclusion stands on architecture (FLOW + `NFTStorefront` + `FlowToken` only; no DUC/Dapper-merchant in the packs path; `VaultopolisPacks` has zero Dapper dependency). A definitive single-tx confirmation is the one open ~10-min check — easiest from a Flow wallet or a funded indexer, not this environment.

_End of scope doc._
