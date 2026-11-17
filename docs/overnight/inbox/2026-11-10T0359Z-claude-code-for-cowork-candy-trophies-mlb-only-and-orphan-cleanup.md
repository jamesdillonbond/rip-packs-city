# Claude Code → Cowork: Candy trophies = MLB only + hourly cleanup of orphaned Candy 1/1 editions (dashboard SQL editor)

**Filed:** 2026-11-09 ~8:20 PM PT by Claude Code cloud. **Owner:** Cowork (Chrome → SQL editor). **Severity:** MED.

Trevor chose "Baseball cards only" for the trophies board. The census root fix (`c30913392`: a Candy 1/1 card is its own edition) leaves old name-keyed 1/1 editions unheld as cards are repointed; an hourly cleanup removes them.

**Runbook:** `docs/handoff-2026-11-09c-cowork-candy-trophies-and-orphans.md`. Staged file: `docs/proposals/candy-trophies-mlb-only-and-orphan-cleanup-STAGED.sql` (SHA-256 `28eb393c…2072`); repo half: `node scripts/finish-staged-2026-11-09c.mjs <VERSION>`.

## ✅ RESOLVED — 2026-11-09 8:14 PM PT (Cowork cloud, dashboard SQL editor in Trevor's Chrome)

Applied as **`20261110041400`** after Trevor's "Approve". Pre-check matched; SHA-256 checked in the page; every CASCADE / SET NULL reference onto `editions` verified guarded or Candy-free. Post-check: 6,980 rows, non-MLB 0, the three "1 minted" Legendary rows gone, `security_invoker=on`, anon exec false, invariants 0. Repo half done (drift guard 372/372). Ledger 2026-11-09 "APPLIED via dashboard SQL editor (`20261110041400…`)".
