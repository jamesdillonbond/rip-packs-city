# Handoff — UFC's market closure is presentation-only; the data layer still publishes confident prices

> ## ✅ DRAINED 2026-08-03 (PT) — do NOT re-execute
> All three recommended steps shipped in **`20cef621`** ("honor market-closed collections in pricing + wallet totals"), committed as `supabase/migrations/20260804_050000..050400_*.sql`:
> 1. **Schema** — `collections.market_closed_at timestamptz`, UFC = 2026-05-13 (`audit_20260804_collections_market_closed_at`).
> 2. **Pricing** — BEFORE INSERT trigger `fmv_snapshots_cap_closed_market_confidence` caps confidence to STALE (`audit_20260804_fmv_cap_confidence_closed_market`). **UFC HIGH/MEDIUM 14 → 0**; TS/AllDay/Candy/Golazos verified byte-unchanged. Pinned as a DB invariant by `supabase/tests/fmv_snapshots_cap_closed_market_confidence.sql`.
> 3. **Wallet path** — all three grand-total RPCs exclude closed markets while keeping the moment count (`get_cross_collection_portfolio`, `get_wallet_collection_snapshot`, `holdings_summary`), plus the count-and-note UI.
>
> The Rakic carve-out floated below was deliberately **not** taken — UFC publishes no confident price at all. Detail + revert paths: `docs/overnight/ledger.md` 2026-08-04. Kept for the reasoning, not as an open item.

**Date:** 2026-08-04 · **For:** Claude Code
**Follows:** `53ff1fa5` (UFC closed-market disclosure), which shipped the banner half of Gate 1 item 4.

---

## Context

Nothing shipped for this — Cowork measured it and stopped, because the durable fix is a pipeline change and the one-off DB edit would be overwritten within a day.

`53ff1fa5` correctly added closure disclosure to sets and analytics. **But the closure exists only in presentation code.** There is no closure fact anywhere in the database — `collections` has `id, slug, name, chain, contract_address, is_active, created_at, updated_at, hobby` and nothing else. No `market_closed_at`, and no function or view in the schema references `market_closed`, `closed_at` or `dead_market`.

The 08-03 roadmap predicted exactly this: *"No freshness heuristic can catch that; only the closure fact can."* **That fact is not recorded**, so every data-layer consumer — confidence labels, wallet totals, and any future surface — is still unaware.

⚠ `is_active` is not the place for it. It is a nav/UI flag, and the standing rule is that nav flags must not govern data pipelines (the `published` flag already caused a Candy wallet to render $0 this way).

---

## Defect 1 — 14 editions labelled HIGH/MEDIUM on a market with no trades in over a year

Snapshots are recomputed **daily** (age 1.0 days), stamping a fresh timestamp and a confident label onto editions whose last real sale was **363–430 days ago**. All have **0 sales in 90 days**.

| player | confidence | published FMV | snapshot age | days since last sale | sales ever |
|---|---|---|---|---|---|
| Dustin Poirier | MEDIUM | **$313.43** | 1.0d | **387** | 23 |
| Derrick Lewis | **HIGH** | **$172.09** | 1.0d | **430** | 55 |
| Arman Tsarukyan | MEDIUM | $137.70 | 1.0d | 387 | 108 |
| Tatiana Suarez | MEDIUM | $64.08 | 1.0d | 377 | 88 |
| Josh Emmett | **HIGH** | $55.79 | 1.0d | 393 | 71 |
| Brian Ortega | MEDIUM | $55.53 | 1.0d | 405 | 48 |
| Carlos Ulberg | MEDIUM | $42.78 | 1.0d | 363 | 62 |
| Diego Lopes | MEDIUM | $19.85 | 1.0d | 363 | 170 |
| + 6 more | MEDIUM | $0.60–$14.23 | 1.0d | 368–399 | 70–189 |

**14 of UFC's 15 HIGH/MEDIUM editions are this defect — 93%.** Total published value $920.24. (The 15th, Aleksandar Rakic, had a sale 82 days ago and is arguably legitimate.)

`algo_version` is `1.7.0` on all of them, so this is the main recalc path, not a legacy writer.

**Scope check — this is a UFC problem, not a platform one:**

| collection | HIGH/MED priced | fresh snapshot on a dead edition | published value |
|---|---|---|---|
| **UFC Strike** | 15 | **14 (93%)** | $920.24 |
| NBA Top Shot | 6,983 | 165 (2.4%) | **$1,247.50** |
| NFL All Day | 1,675 | **0** | — |
| Candy MLB | 74 | **0** | — |
| LaLiga Golazos | 3 | **0** | — |

Top Shot's 165 average **$7.56** and are edition-level dormancy, not market closure — a different and much smaller problem. **Do not bundle them into this fix.**

## Defect 2 — UFC wallets still total

`wallet_moments_cache` carries **2,842 UFC rows with an FMV, summing to $64,976.25, across 112 wallets**, from a market closed since 2026-05-13 (83 days). The roadmap's bar was explicit: *"A UFC wallet does not show a total; it shows a count and a note."* That is not met.

This is the larger number and the one a user actually sees.

---

## Recommended fix

**Record the fact, then have the pipelines respect it.**

1. **Schema (Cowork can ship this on your word — it is a fact, not pricing logic):**

```sql
ALTER TABLE public.collections ADD COLUMN market_closed_at timestamptz;
COMMENT ON COLUMN public.collections.market_closed_at IS
  'Date the collection''s secondary market ceased trading. NULL = live. Governs pricing confidence and wallet totals; NOT a nav flag.';
UPDATE public.collections SET market_closed_at = '2026-05-13' WHERE slug = 'ufc_strike';
```

2. **Pricing path (yours):** where a collection has `market_closed_at IS NOT NULL`, confidence must not exceed `STALE`, regardless of what the sales window computes. The closure fact overrides the heuristic — that is the whole point.

3. **Wallet path (yours):** a wallet containing a closed collection shows a **count and a note**, not a total; and the cross-collection total excludes it with a named disclosure line.

**I did not ship step 1 alone.** An inert column that nothing reads is the same non-fix I declined for the `unmapped_sales` attempt counter, and a one-off `UPDATE fmv_snapshots` would be recomputed back to MEDIUM inside 24h — the daily snapshot age proves that. Say the word and the migration goes out with your change.

## Revert path

Step 1: `ALTER TABLE public.collections DROP COLUMN market_closed_at;` — additive and nullable, no existing consumer.
Steps 2–3: `git revert <sha>`.

## Verification

- After step 2, re-run: UFC HIGH/MEDIUM count should be **0** (or 1, if you keep Rakic on his 82-day sale).
- After step 3, a UFC-only wallet renders a count and a note, no dollar total.
- Re-run the scope table above — All Day / Candy / Golazos must stay at 0, confirming no collateral relabelling.

---

## Guardrails

- Direct to `main`, no branches, no PRs. PowerShell `git`; verify `git rev-list --count origin/main..HEAD` = 0.
- Log to `docs/overnight/ledger.md` with the revert path; ledger committed **before** the code.
- ⚠ Git history rewritten 2026-08-03 — find pre-purge commits by message, not SHA.

**Claude Code's direct file inspection wins over this doc on any disagreement.**

## Expected end state

The closure fact lives in `collections`, UFC publishes no confident price and no wallet total, and Gate 1 item 4 is genuinely closed rather than closed at the presentation layer.
