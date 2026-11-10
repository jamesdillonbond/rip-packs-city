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

## ↳ 2026-11-09 ~7:40 PM PT — interim guard measured; NOT staged (Claude Code cloud)

- **View guard (option 2) costs too much.** Rewriting `v_insights_trophies` so a 1/1 needs < 2 DISTINCT `moment_id`s in `wallet_moments_cache` (distinct, so a stale seller row does not demote a real 1/1) takes the board from 2.65 s to **7.1 s cold** (+7.6k cold index reads; the probe runs for every circulation-1 edition). It would demote **179 rows** (7,551 → 7,372) but trip the 7,000 ms liveness budget routinely. Not worth shipping as the interim.
- **App-side guard in `lib/insights/trophies-board.ts`** (check only the displayed page) cannot be done honestly with a plain PostgREST read: per-edition counts need a small SQL function because the 1,000-row clamp truncates (Bat Cowl alone has 4,404 rows). So it is another Cowork SQL-editor step for a stopgap.
- **Exposure today:** Candy IS a trophy collection (`TROPHY_COLLECTIONS` includes `candy_mlb`). The "rarest first" sort (`circulation` asc) and the Candy tab put these rows at the top. The default FMV-desc view mostly does not reach them (the census editions are largely unpriced).
- **Recommendation:** go straight to the root fix (key Candy editions so the 32-char name cut cannot merge different cards, and write `circulation_count` only from an explicit "/n"). Re-baseline the liveness budget after it.

## ↳ 2026-11-09 ~8:00 PM PT — the guard IS live; no repo file; 3 rows still say "1 minted" (Cowork cloud)

- **Live, despite "NOT staged" above:** `supabase_migrations.schema_migrations` has `20261110034117 audit_20261109_trophies_view_held_twice_is_not_one_of_one` (7:41 PM PT), and the live `v_insights_trophies` computes `one_of_one = circulation_count = 1 AND h.n < 2` (DISTINCT `moment_id`s in wmc by `edition_key = external_id`, LIMIT 2). There is **no migration file** for it on `main` (`ls supabase/migrations | grep held_twice` → 0). Whoever applied it: commit the file under that version (or revert it on purpose) — `npm run db:migrations:recover` will otherwise pull it as fileless drift.
- **Effect, measured on the live view:** Candy rows with `is_one_of_one` = 4,223; held by more than one card = **0**. Of the 183 contradicting editions, 180 are now off the board and 0 are labelled 1-of-1.
- **Still false on the page — 3 rows, admitted as top tier (LEGENDARY), not as 1-of-1:** `c:the-bat-cowl-collection:bat-cowl-legendary` (4,404 held), `c:palm-garden-inklings:inkling-legendary` (597), `c:bat-cowl-honorary-collection:bat-cowl-honorary-legendary` (4). Each has `circulation_count = 1`, so `TrophiesBoardClient` renders `/1 Legendary` and **"1 minted"** (`rowBadge` / `rpc-tr-circ` read `circulation_count`). The census root fix (write `circulation_count` only from an explicit "/n") clears them; a view-level drop of `circulation_count = 1 AND h.n >= 2` from the final WHERE would too, at no extra cost (h is already computed for exactly those rows).
- **Liveness:** the next board probe (8:28 PM PT) is the first under the guard; the measured 7.1 s cold sits at the 7,000 ms budget.
- Not changed by me — this is the other session's in-flight work.
