# Candy / Solana Chain-Two — FIRM TRIPWIRE Audit (July 8, 2026)

**Run type:** Autonomous scheduled task (`candy-audit-firm-tripwire-july8`), read-only.
**Methodology spec:** [docs/candy-audit-checklist-2026-05-30.md](../candy-audit-checklist-2026-05-30.md) (July 8 firm-tripwire section).
**Prior:** [docs/audits/candy-audit-interim-2026-06-22.md](candy-audit-interim-2026-06-22.md) (interim — leaned NO-GO, expected Outcome #2 / defer).
**Purpose:** The firm tripwire decision — whether chain-two implementation code may begin.
**Constraints honored:** No production DB touched. No schema change. No Solana code added. No promotional content. CLAUDE.md and strategy docs untouched. The Candy-vs-Beezie ordering decision is **surfaced, not made** (per task rules).

---

## OUTCOME: #2 — DEFER chain-two (~60 days). Do NOT start chain-two code.

Two of three tripwire conditions clear. **Condition #1 (≥30 days of Candy Solana sales history) fails decisively**, and it is the governing condition per the strategy doc. This is not a close call and not a structural failure of the target — it is a rollout-schedule slip. The Candy/Solana target remains sound on every structural axis; the *data* to index simply does not exist yet.

| # | Condition | Status | One-line basis |
|---|---|---|---|
| 1 | ≥30 days of Candy Solana sales history | **FAILS (hard)** | Flagship 2026 product not yet on sale (Drop 1 = **July 15**, 7 days *after* the tripwire); no verified/liquid Candy Solana collection discoverable on any marketplace; effectively ~0 days of measurable secondary history. |
| 2 | Defined edition/serial schema RPC can index | **CLEAR** | Metaplex Core; on-chain serial + edition numbers (Candy FAQ confirms they "carry over unchanged"); Metaplex Certified Collections for grouping; on-chain royalty enforcement; Helius DAS + Magic Eden/Tensor public APIs. Dynamic 2026 stats live in off-chain Arweave JSON → need a refresh pipeline (design note, not a blocker). |
| 3 | Chain-abstraction Phases A–F complete | **CLEAR** | All phases A–F shipped by 2026-06-01 (CLAUDE.md "Chain strategy": A+B `audit_20260530…`; C `d9323f9`; D `01b3878`+`1b7cfde`; E `205024c`; F `audit_20260601_collections_chain_drop_default`). |

The interim (June 22) predicted exactly this. Nothing discovered on July 8 changes the direction of the target; it confirms the timing was optimistic.

---

## The crux: the flagship product hasn't launched, and the 30-day clock still hasn't started

The single most decisive new fact this run is a Candy blog post **dated July 8, 2026** (published 19:16 UTC — the tripwire day itself):

> **"2026 MLB Base Series ICONs: The Chase Begins July 15" — The first Base Series drop goes live on July 15, featuring a limited release of 500 packs.**

So on the tripwire date:

- The **2026 MLB Base Series ICONs** — the dynamic-stat flagship that is the *entire* reason Candy is an attractive intelligence target — has **not sold a single pack**. Drop 1 (500 packs, $10, 10 ICONs/pack, Cores /250, Rainbow inserts /15) goes on sale **July 15, 2026**. Total 2026 Base Series supply is just 2,500 packs across all drops.
- Even in the best case, primary sales begin July 15 → secondary trading of those assets begins later still → **30 days of secondary history is impossible before roughly mid-to-late August at the earliest**, and that is against a tiny 2,500-pack pilot float that will produce thin, sporadic volume.
- **Legacy-asset secondary trading is still described in future tense** in Candy's *current* FAQ (banner: "Last revised May 2026"): *"Secondary trading **will be** available through supported third-party Solana marketplaces including Magic Eden, with more to be announced."* No past-tense "is live," no marketplace link, no verified collection.
- **No verified, discoverable, liquid Candy Digital Solana collection** surfaced on Magic Eden or Tensor across multiple targeted searches — so there is still **no on-chain anchor** (collection pubkey / candy-machine ID) to point an indexer, holder snapshot, or sales query at. Same state as June 22.

Candy's own framing calls the 2026 Base Series a **"pilot drop built around re-engaging collectors, testing new mechanics"** — i.e. Candy itself is still in a re-launch/testing posture, not steady-state liquid trading.

---

## Probe results (five probes, read-only)

### Probe 1 — Public Candy marketplace API
**No public marketplace API; unchanged from June 22.** candy.io is a login-gated Next.js/Vercel storefront for *primary* sales only (`dpl_…` deployment IDs, `/login`, `/register`, `/user`). No `docs.candy.io`, no documented endpoints, support is a `fan-help@candy.io` mailbox. Candy explicitly routes secondary trading **off-platform** to third-party Solana marketplaces. **Not a blocker** — RPC's chain-two data path was never going to be a "Candy API"; it is on-chain (Helius DAS) + Magic Eden/Tensor public APIs + Arweave. The blocker is that tradeable data doesn't exist yet, not that an API is missing.

### Probe 2 — Metaplex Core asset structure
**Schema characterization holds; still could not run `getAccountInfo` against a real Candy mint** because no verified Candy Solana mint address is publicly available. Confirmed from Candy's current FAQ + product materials: Metaplex Core, **on-chain royalty enforcement** ("embeds royalty enforcement directly into the code"), **edition + serial numbers carry over unchanged** on-chain, **Metaplex Certified Collections** for third-party grouping ("makes it easy for third parties like exchanges to group and track sets… and prevent fakes" — directly relevant to how RPC would group a Candy set). Dynamic 2026 season stats are mutable → off-chain Arweave JSON → require a metadata-refresh pipeline (AllDay consumer-GQL pattern). **Indexable and clean; re-verify against a real mint post-launch.**

### Probe 3 — Secondary trading venue + volume
**Magic Eden is the named de-facto venue; Candy runs no order book; Tensor is a viable second source. Volume = not yet measurable (no live verified collection).** Candy FAQ + blog consistently name Magic Eden ("with more to be announced"). Both Magic Eden and Tensor expose public collection/stats/activity APIs. Confirms the prebuilt ingest architecture — but there is nothing trading to point it at today. (Reminder from the interim: the Magic Eden "Candies" collection is an **unrelated** Pixel-by-Pixel Studios pixel-art set — do NOT wire RPC to it. Same trap class as the unrelated NxGen `$CAND` token.)

### Probe 4 — Holder distribution
**Could not be measured** — no verified Candy Solana collection to snapshot; migrated legacy assets largely still sit in Candy-generated custodial wallets not yet self-custodied/exported. From product design (2026 Base Series: /250 Cores, /15 Rainbows, $10 packs, quests, burn-for-credit "Diamond Economy"; historical 2023 ICON structure of 1-of-1 / /40 / /100 long tails) the retail-collector cohort thesis *looks* to transfer to RPC's 100–2,000-asset target audience — but this remains **unverified** and must be confirmed with a real holder snapshot post-launch.

### Probe 5 — 30-day sales volume + price coverage (NEW this run)
**Could not be executed — there is no 30-day (or any meaningful) window of Candy Solana secondary sales to measure.** Primary sales of the flagship line begin July 15; legacy secondary is not demonstrably live/liquid. Sales/day, p10/p50/p90 prices, time-since-last-sale, and volume-per-edition shape are all **N/A** at the tripwire. This is the probe that most directly governs condition #1, and it returns empty by the genuine state of the rollout, not by tooling failure.

---

## Recommendation

1. **Defer chain-two by ~60 days. Hold all chain-two code.** No Solana ingest, no `lib/collections.ts` `candy-mlb` flip, no `helius-proxy` worker, no schema changes. Conditions #2/#3 being clear does not authorize starting; condition #1 governs and fails.
2. **Re-anchor the gate.** Redefine condition #1 as **"≥30 days of verified Candy secondary sales, measured from the first live trading day of a verified Candy Solana collection"** — not from a target/marketing date. The checklist's original June-8 anchor is obsolete.
3. **Next audit ≈ September 8, 2026** (~30 days after the earliest plausible secondary-trading start that follows the July 15 primary drop). At that run, first establish a **verified collection pubkey** (via a migrated-asset detail page, a Magic Eden verified listing, or Helius DAS by Candy's creator/update-authority), then finally execute Probes 2/4/5 against real assets.
4. **Watch items before the next audit** (read-only, no action): the July 15 Drop-1 outcome (did it sell out / mint on Solana as expected), first appearance of a verified Candy collection on Magic Eden/Tensor, and whether Candy opens legacy-asset secondary trading in past tense.
5. **Standing rules unchanged:** [[no-promo-until-launch-ready]], [[no-paywall-until-traction]], intelligence-first. Public tagline stays "Flow blockchain digital collectibles intelligence platform." Flow quality bar does not drop.

---

## Decision to surface to Trevor (NOT made here): Candy-vs-Beezie chain-two ordering

CLAUDE.md's own framing (Chain strategy → "Beezie/Base parallel data plane") states the Beezie/Base `evm_*` plane stays parallel until *either* (a) Beezie gets a real product consumer, *or* **(b) "the July 8 Candy/Solana tripwire fails and Beezie/Base becomes the chain-two pivot target."**

**Condition (b)'s trigger has now occurred: the July 8 tripwire has failed on condition #1.** Per the strategy doc this is precisely the moment to *consider* — not execute — promoting Beezie/Base ahead of Candy. This audit deliberately does **not** make that call (task rule: do not decide the ordering unilaterally). Framing for Trevor's decision:

- **Argument to still wait for Candy:** the target is structurally ideal (MLB/DC/Netflix/Getty IP, retail-collector float, clean Core serial/edition schema, enforced royalties) and the only failure is timing. A ~60-day defer likely clears it. Beezie/Base has 1.01M transfers + 1,828 holders indexed since ~May 13 but **no product consumer** — promoting it means building a second chain-two from scratch, which the strategy doc's "never parallel" rule was written to avoid.
- **Argument to pivot to Beezie/Base now:** Candy has slipped twice (June-8 → July-15 flagship), is self-describing as a "pilot… testing new mechanics," and a 2,500-pack pilot float may stay too thin for a meaningful FMV/intelligence layer for months. Beezie/Base data already exists and is already flowing.
- **A third path:** hold both — keep Candy as chain two on the re-anchored September gate, and separately evaluate whether Beezie deserves a *product consumer* on its existing parallel plane (which would satisfy condition (a) without a chain-two promotion).

**No action taken on this. Surfaced for direction.**

---

## Methodology & sources

**Tools:** WebSearch + web_fetch only (sanctioned web tools). No raw Solana RPC calls (no verified Candy mint address to call — the same genuine-state blocker as June 22, not a tooling gap). No production DB, no Chrome automation, no code.

Key sources (this run):
- Candy blog index (current, shows newest posts): https://blog.candy.io/
- Candy — "2026 MLB Base Series ICONs: The Chase Begins July 15" (**Jul 8, 2026** — flagship Drop 1 = July 15): https://blog.candy.io/2026-mlb-base-series-icons-the-chase-begins-july-15/
- Candy — "2026 MLB Base Series ICONs and the Diamond Economy" (Jun 17, 2026): https://blog.candy.io/2026-mlb-base-series-icons-and-the-diamond-economy/
- Candy — FAQ (banner "Last revised May 2026"; secondary trading still future-tense; Core/serial/edition/royalty confirmations): https://www.candy.io/faq
- Candy — "Candy's New Site Is Live" (Jun 1, 2026): https://blog.candy.io/candys-new-site-is-live-what-fans-can-expect-today/
- Metaplex Core (schema reference, carried from interim): https://www.metaplex.com/docs/smart-contracts/core/what-is-an-asset

Carried-forward reference: [docs/audits/candy-audit-interim-2026-06-22.md](candy-audit-interim-2026-06-22.md); [docs/candy-audit-checklist-2026-05-30.md](../candy-audit-checklist-2026-05-30.md).

## What this audit deliberately did NOT do

No launch copy / tweets / Reddit / promo; no Solana code in the repo; no `chain_type` enum change; no production DB or cron touch; no brand/tagline or pricing decision; no chain-two implementation start; no unilateral Candy-vs-Beezie ordering decision. Findings + a deferral proposal only.
