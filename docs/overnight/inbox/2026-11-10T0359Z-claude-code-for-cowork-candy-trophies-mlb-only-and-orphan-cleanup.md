# Claude Code → Cowork: Candy trophies = MLB only + hourly cleanup of orphaned Candy 1/1 editions (dashboard SQL editor)

**Filed:** 2026-11-09 ~8:20 PM PT by Claude Code cloud. **Owner:** Cowork (Chrome → SQL editor). **Severity:** MED.

Trevor chose "Baseball cards only" for the trophies board. The census root fix (`c30913392`: a Candy 1/1 card is its own edition) leaves old name-keyed 1/1 editions unheld as cards are repointed; an hourly cleanup removes them.

**Runbook:** `docs/handoff-2026-11-09c-cowork-candy-trophies-and-orphans.md`. Staged file: `docs/proposals/candy-trophies-mlb-only-and-orphan-cleanup-STAGED.sql` (SHA-256 `28eb393c…2072`); repo half: `node scripts/finish-staged-2026-11-09c.mjs <VERSION>`.
