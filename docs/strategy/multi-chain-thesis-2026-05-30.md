# RPC Multi-Chain Thesis (Draft 2026-05-30)

**Status:** Draft for Trevor's review. Not committed. CLAUDE.md not yet updated.

**Companion doc:** [docs/migrations/chain-abstraction-plan-2026-05-30.md](../migrations/chain-abstraction-plan-2026-05-30.md)

---

## What's changing

Until today, RPC's stated thesis has been "Flow blockchain digital collectibles intelligence platform." That tagline has worked because all five published collections (Top Shot, NFL All Day, LaLiga Golazos, UFC Strike, Disney Pinnacle) live on Flow, and the architecture is Flow-shaped end-to-end.

The thesis under consideration: **"Sports & IP digital collectibles intelligence — Flow is chain one of N."** Same product capabilities (FMV, badges, squeeze, cohort, concierge), larger TAM, fewer single-ecosystem dependencies.

This is a strategic-framing shift, not a near-term feature add. Chain two is sequenced after the foundation work; no second-chain code ships until both the schema refactor and a tripwire audit conclude.

## Why now (May 30, 2026)

Three signals stacking, in order of weight:

- **Single-chain risk is structural.** A solo-dev intelligence platform anchored on a chain controlled by a single company (Dapper) is fragile by design. Business continuity argues for chain diversity *before* scale forces it, not after.
- **Brand portfolios are leaving Flow's neighborhood.** Candy's Solana pivot (live trading June 8, 2026) consolidates MLB, DC, Netflix, WB, Getty on a non-Flow chain. None of those IPs were ever on Flow — but the consolidation under one Solana platform makes the gap visible. Sports-IP collectibles are increasingly chain-pluralistic.
- **Flow's collectibles volume isn't growing.** Top Shot is past its 2021-22 peak; the April 2026 pack-resumption inflection produced volume but not durable new-collector growth. The 100-2,000-moment cohort RPC targets is real but small and not expanding.

## The two theses, decided

**Thesis A — Flow intelligence specialist.** Stay deep on Flow. Lower architectural cost. Higher single-ecosystem risk. TAM ceiling is Flow's trajectory.

**Thesis B — Sports/IP collectibles intelligence (multi-chain).** Same product applied across chains where sports/IP collectibles live. Higher architectural cost upfront. Larger addressable audience. Hedges Flow.

**Working decision: Thesis B.** Flow stays the flagship. Chain additions are sequenced, not parallel — one chain at a time, fully integrated and stable before the next starts. The change is in *posture*, not in immediate visible product.

## What does NOT change

- **The "no paywall until 50 WAU" rule.** Multi-chain doesn't unlock monetization earlier.
- **The "no promo until launch-ready" rule.** No tweets, no Reddit posts, no TC DMs about multi-chain until chain two ships visible product.
- **Flow as the flagship.** Top Shot, AllDay, Golazos, UFC Strike, Pinnacle remain the highest-quality intelligence surfaces and the visible product. Quality bar on Flow does not drop while chain two is built.
- **The brand "Rip Packs City."** Multi-chain doesn't require a brand pivot. Tagline updates only when chain two ships visible product.
- **Trevor's Top Shot Team Captain status.** Differentiation kept; it's a content/relationship asset that doesn't depend on the platform being single-chain.
- **The intelligence-first commitment.** Cart/live-buy stays shelved. Outbound "View Listing" links remain the model on the Flow side and become the default model on chain two.

## Second-chain decision framework

The second chain is chosen by these criteria, in this priority order:

1. **Sports/IP collectibles exist on it with depth.** Floor-only PFP markets don't qualify.
2. **The data is rich enough for RPC-style intelligence.** Edition/serial structure, badge or scarcity layer, holder distribution worth analyzing.
3. **The intelligence niche is underserved.** "Floor and volume" tools exist on every chain; "is this Aaron Judge ICON Scarcity 2 a buy vs comps" tools mostly don't.
4. **Acquisition cost is bounded.** New chain client + new indexer + new wallet model is acceptable. Rewriting FMV from scratch is not.

### Candidate ranking

| Chain | Sports/IP depth | Data richness | Intelligence niche | Acquisition cost |
|---|---|---|---|---|
| Solana (Candy) | High — MLB, DC, Netflix, WB, Getty | Unknown until June 8 launch | Sports-IP weak among existing Solana tools | High — Solana stack fully different from Flow |
| Starknet (Sorare) | High — soccer | High — mature, badge/scarcity structure | Sorare's own intelligence is decent | Medium — L2-specific tooling adds friction |
| Polygon (NFL Rivals / Mythical) | Medium | Medium — more game-context than collectible-context | Open lane | Medium — EVM, reusable for future EVM chains |
| Base | Low for sports today | N/A | N/A | Cheap once an EVM foundation exists |
| Ethereum mainnet | Fragmented across many collections | Mixed | Saturated | Cheap once an EVM foundation exists |

**Leading recommendation:** Solana / Candy, *conditional* on a data audit at ~June 22, 2026 (two weeks past Candy market open).

Reasoning: brand strength is decisive, the intelligence-niche fit looks real (Tensor / Magic Eden / Hyperspace handle floor-and-volume well but not sports-IP context), and timing means RPC arrives at marketplace open rather than chasing.

**Fallback:** Sorare if Candy turns out floor-only / metadata-thin. Defer the EVM family until a sports IP gives one of its chains real depth.

### Tripwire to start chain-two code

All three required:

- ≥30 days of Solana sales history on Candy assets (so chain-two work begins **no earlier than July 8, 2026**).
- Defined edition/serial schema RPC can index (verified by reading Metaplex Core asset structure plus marketplace API or chain-trace).
- Chain-abstraction refactor (Phases A-F in the migration plan) **complete** — not in progress.

If any of the three fails the audit, the tripwire holds and Sorare gets a comparable audit.

## Sequencing

**Stage 0 — Now → mid-June 2026.** Chain-abstraction schema refactor. See companion plan doc. Estimate: ~1 week focused solo. Zero behavior change for Flow.

**Stage 1 — Mid-June → late-June 2026.** Candy data audit. Read Metaplex Core asset structure, audit Candy marketplace API (or determine that Magic Eden / Tensor are the de facto data layer), assess intelligence-niche fit. Tripwire decision: chain two = Candy, or pivot to Sorare audit.

**Stage 2 — July 2026 onward.** Chain-two indexer + intelligence. Builds on Stage 0 foundation. Estimate 3-4 weeks if Solana, 2-3 weeks if Sorare.

**Stage 3 — August 2026+.** Each additional chain becomes weeks not months because the foundation exists. Brand tagline updates only when product is visibly multi-chain (i.e. chain two has shipped and is reachable from the navigation).

## Open questions deferred to chain-two work

These don't need answers now; they need to be on the radar so we don't paint ourselves into a corner.

- **UI/UX shape.** Today `/[collection]` assumes Flow flavor. Multi-chain wants either `/[chain]/[collection]` or implicit chain inferred from the collection slug via the registry. Leaning implicit because URLs without chain prefixes read cleaner and the registry already knows.
- **FMV calibration per chain.** `lib/fmv-confidence.ts` HIGH/MEDIUM thresholds are calibrated to Flow liquidity. Solana's spread structure and time-decay are different.
- **Tier vocabulary divergence.** Flow already has three tier vocabularies (TS: COMMON/FANDOM/RARE/LEGENDARY/ULTIMATE; UFC: CHALLENGER/CONTENDER/FANDOM; Pinnacle: chaser/edition-type). Candy adds scarcity levels. Per-chain tier filters are a chain-two concern.
- **Cron ceiling.** cron-job.org free tier vs 23 active jobs today. Each new chain adds 5-10 pipelines. Either consolidate or pay before chain three.
- **Brand drift.** "Rip Packs City" is pack-opening-culture, not Flow-specific. Holds for now. Revisit if/when a chain dominates that has different vocabulary.
- **Concierge tool surface.** `/api/support-chat` currently has 5 Flow-scoped tools. Chain-two adds tools; whether they're chain-namespaced (`get_fmv_solana`) or chain-aware (`get_fmv` with a chain param) is a chain-two design decision.

## Decisions Trevor owns before execution starts

1. Confirm Thesis B direction (or override). The schema refactor doesn't ship until this is yes.
2. Approve Candy as the leading chain-two target *subject to the June 22 audit* (or override to Sorare-first).
3. Approve the migration plan in [docs/migrations/chain-abstraction-plan-2026-05-30.md](../migrations/chain-abstraction-plan-2026-05-30.md).
4. Confirm CLAUDE.md updates are deferred until execution begins (i.e. after this doc is reviewed and approved).
