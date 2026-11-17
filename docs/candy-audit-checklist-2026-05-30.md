# Candy / Solana Chain-Two Data Audit Checklist

**Created 2026-05-30.** Methodology for the June 22 interim check and July 8 firm tripwire.

**Context.** Per [docs/strategy/multi-chain-thesis-2026-05-30.md](strategy/multi-chain-thesis-2026-05-30.md), Candy/Solana is the working chain-two target. The decision to start chain-two implementation code is gated on the three tripwire conditions below. This doc is the runbook for evaluating them.

**Important caveat (added 2026-05-30 same day).** The DB-side chain-aware-reads audit found an active Base mainnet indexer for Beezie Collectibles (1.01M transfers, 1,828 holders) that has been running since ~May 13. The Candy/Solana sequencing in the strategy doc may be revised based on that discovery — if Trevor promotes Beezie/Base to chain-two product surface, Candy moves to chain three. This checklist is still valid; only the ordering changes.

---

## Tripwire conditions (all three must clear)

1. **≥30 days of Solana sales history on Candy assets.** Earliest 2026-07-08 because Candy marketplace trading opens 2026-06-08.
2. **Defined edition/serial schema RPC can index.** Verified by reading Metaplex Core asset structure plus Candy marketplace API (or secondary-marketplace API if Candy lets Magic Eden / Tensor handle trading).
3. **Chain-abstraction Phases A-F complete.** A and B shipped 2026-05-30; C/D/E with Claude Code; F gated on D soak.

---

## June 22 interim audit (two weeks post-marketplace-open)

Purpose: early data-availability check. We're NOT making a tripwire decision yet — that's July 8 — but this catches show-stoppers two weeks earlier so they don't blindside us.

**Read-only probes only. Do NOT touch the DB. Do NOT generate launch copy. Do NOT propose code changes.**

### Probe 1: Does Candy expose a public marketplace API?

- Hit `https://candy.io/api/*` and look for public endpoints. Check headers, rate limits, auth requirements.
- Check `https://docs.candy.io` for developer docs (URL is a guess; verify).
- Look at network panel on `https://candy.io` while browsing a listing — what JSON shapes come back? Are they keyed by mint pubkey, by edition number, by something else?

**Findings to record:**
- API base URL (or "no public API found")
- Endpoints exposed (listings, sales, holders, asset metadata)
- Rate limits if documented
- Auth model (open, API key, OAuth)
- Pagination model
- Whether `editionNumber` / `scarcityLevel` / `playerName` / equivalents come back as structured fields or only embedded in opaque JSON

### Probe 2: What does a Candy Metaplex Core asset actually look like on-chain?

Pick a recent Candy mint pubkey from the marketplace UI. Use Solana RPC (public endpoint or Helius free tier) to:

```
getAccountInfo(<mint_pubkey>)
```

Parse the Metaplex Core asset structure. Confirm:
- Plugin types attached (Royalty, FreezeDelegate, Attributes, Edition)
- Whether `editionNumber` / `scarcityTier` / `playerName` / event timestamp are first-class on-chain attributes, or off-chain JSON (Arweave) only
- Royalty enforcement model
- Whether the asset is part of a Collection (Metaplex Core Collection plugin)

**Decision input:** rich on-chain attributes = indexable easily. Arweave-only JSON = needs metadata-fetch pipeline (similar to AllDay consumer-GQL pattern).

### Probe 3: Where will secondary trading actually happen?

- Magic Eden Candy collection page (URL TBD) — what's the listed volume? How does Magic Eden surface Candy editions?
- Tensor — same.
- Candy.io's own marketplace (when live June 8) — does it expose a separate API or does it embed Magic Eden / Tensor?

**Decision input:** if Magic Eden is the de facto liquidity layer, RPC's chain-two data source is Magic Eden's public API + on-chain. If Candy runs its own order book, RPC needs Candy's API specifically.

### Probe 4: Holder distribution

Pull a snapshot of Candy holders for one popular collection (e.g. MLB ICON Leadoff). Goal: confirm there's a 100-2,000-asset cohort similar to RPC's Flow target audience.

- Total distinct holders
- Median holdings per holder
- Distribution shape (whale-heavy vs. long-tail)

**Decision input:** if holder distribution is mostly whales (10,000+ assets each), RPC's intelligence-for-collectors thesis doesn't transfer. If it's long-tail with a meaningful 100-2,000 cohort, transfer works.

### June 22 deliverable

A short audit report (no shipping) committed at `docs/audits/candy-audit-interim-2026-06-22.md` covering:
- The four probes above
- A go/no-go signal for the July 8 firm tripwire
- Any blockers discovered (e.g. "no public API exists; chain-two requires partnership conversation")

---

## July 8 firm tripwire audit

Purpose: tripwire decision. Same probes as June 22, with one addition: **30-day sales-volume snapshot**.

### Probe 5: 30-day Candy sales volume + price coverage

- Daily sales count for the top-3 Candy collections
- Median sale price, p10/p50/p90
- Median time-since-last-sale by edition (= RPC's "stale" signal proxy)
- Sales-volume-per-edition distribution

**Decision input:** if median edition has <5 sales/30d, FMV pipeline will be NO_DATA-heavy like RPC's TS tail. If volume is meaningful, intelligence layer adds real value.

### July 8 deliverable

`docs/audits/candy-audit-final-2026-07-08.md` with one of three outcomes:

1. **All three tripwire conditions clear** → propose chain-two implementation plan to Trevor. Surface candidate next steps (Solana RPC client, indexer architecture, edition normalization, FMV adaptation, schema additions). Wait for direction.
2. **Some conditions clear, others don't** → propose deferring chain-two by 30/60/90 days, document what changes the gate. Hold position.
3. **Conditions don't clear** → propose pivoting chain-two target. Re-evaluate vs. Beezie/Base (if not yet promoted) or other RWA-collectibles destinations.

---

## What this audit does NOT touch

- Drafting launch copy, tweets, Reddit posts, or any promotional material. [[no-promo-until-launch-ready]] applies.
- Adding Solana code to the repo.
- Modifying the `chain_type` enum (it already has `solana` as a value).
- Touching production DB or cron pipelines.
- Brand / tagline decisions.
- Pricing or paywall ([[no-paywall-until-traction]]).

---

## Run sequence reminder

The June 22 and July 8 audits are scheduled tasks (see `mcp__scheduled-tasks__list_scheduled_tasks` to verify they're set). If a scheduled task fires, it will read this checklist and execute the probes read-only, then surface findings to Trevor without making policy decisions.
