# Claude Code: 183 Candy editions are labelled 1-of-1 but are held more than once, and they show as "1 of 1" on /insights/trophies

**Filed:** 2026-11-09 ~7:18 PM PT by Claude Code cloud (found during the `public_board_slow_count` triage).
**Owner:** whoever owns the Candy collections census (`lib/candy/collections-census.ts`, `lib/chains/solana/normalize.ts`; last touched 5:32 PM PT 11-09). Not fixed here, because that code is being changed tonight by another session.
**Severity:** MED. A false claim on a public board: the honesty class "an empty/a number that CONCLUDES".

## Measured (7:15 PM PT)

- `v_insights_trophies` has **7,551 rows**, up from 2,687 when it was re-baselined on 11-06. Candy contributes **4,869** (4,844 created since 11-08); Panini 14,933 editions qualify, Top Shot 2,116. It now reads 2.65 s warm / 7.6 s cold (one sample over its 7,000 ms liveness budget at 4:28 PM PT — that is the `public_board_slow_count = 1` breach).
- Among hydrated Candy editions with `circulation_count = 1`, **183 are held by more than one card** in `wallet_moments_cache`:
  - **2022 All-Star Tricons: 180 editions, up to 4 cards each.** Likely cause: edition keys come from the on-chain NAME, which is cut to 32 characters ("2022 Tricon Mantiply Musgrove …"), so different trios that share their first two or three names merge into one edition. Each card IS a 1/1; the merged edition is not.
  - **The Bat Cowl Collection: 1 edition, 4,404 cards held, `circulation_count = 1`.** Bat Cowl Honorary Collection: 4 held. Palm Garden: Inklings: 597 held.
- `lib/insights/trophies-board.ts` filters `is_one_of_one` and the page labels such rows "1 of 1". So each of those 183 editions is published as a single-copy trophy.

## What would close it

1. **Root (census owner):** key a Candy edition by something that does not truncate (the asset's full JSON name, or the trio's three player traits) where the on-chain name is cut. Also do not write `circulation_count = 1` when the source's "(n/m)" / "Serial Number" does not say /1. Re-key the 180 Tricons editions the same way as today's repoint of fabricated editions.
2. **Interim guard (view, cheap, honest):** in `v_insights_trophies`, do not set `is_one_of_one` (and do not admit on `circulation_count = 1`) for an edition held by more than one card. A held count above the circulation is a contradiction, not a 1/1. ⚠ That is a full-body `CREATE OR REPLACE VIEW` (keep `security_invoker`) and goes through the Cowork SQL-editor route.
3. **Liveness:** re-baseline `v_insights_trophies.max_ms` only AFTER 1–2. The growth is mostly Candy rows that may not belong on the board.

Nothing shipped. No revert.
