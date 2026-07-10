# Handoff — Rookie-tracker-inspired surfaces (2026-06-26)

Source: crawl of `rookie-tracker.vercel.app` ("Rookie Tracker" by Diamond / @DiamondNFL), a single-page TS-rookies-only competitor. Five features were greenlit to bring to RPC. After grounding each against the live schema, **one is fully data-backed and shipped (DB layer); four are blocked on data/infra RPC does not currently maintain.** This doc is the Claude Code half (frontend + the infra builds Cowork can't push).

Its stack, for reference: 2 Dune queries (on-chain burn/mint/circ), a small Mongo backend (per-player collector leaderboards, set completions, marketplace, price history), and a cached NBA-API JSON (season stats + headshots). RPC's edge is its own deeper indexer; the gap is **complete on-chain ownership + a burn-event log + current NBA stats** — none of which RPC maintains today.

---

## SHIPPED (Cowork, live on Supabase — DB layer only; frontend is yours)

### `topshot_rookie_edition_board` (view) — backs the per-parallel grid (#3) + burn rankings (#2)
Migration: `audit_20260626_topshot_rookie_edition_board_v2_editions_spine`. `security_invoker=on`, granted anon/authenticated/service_role. `check_public_security_invariants()` = [], `check_secdef_anon_execute_violations()` = [] after.

One row per 2025-rookie edition (set × parallel), spine = `editions` (all base + `::subID` parallels), scoped to the `topshot_2025_rookie_players` cohort. Columns: `player_name, set_name, series_number, tier, parallel_id, parallel_name, external_id, circulation_count, fmv_usd, fmv_confidence, low_ask, highest_offer, avg_sale_price, burned, locked, effective_supply, burn_rate_pct, lock_rate_pct, has_full_economics, thumbnail_url, video_url`.

Verified: 431 rows / 61 players / 7 parallels (Standard + Blockchain/Hardcourt/Hexwave/Jukebox/Galactic/Omega) / 8 sets; FMV on 401/431; full economics on 203 (base) editions. Cooper Flagg Origins reads Standard $389 HIGH / Hexwave $672 MEDIUM / Jukebox $1,794 LOW — matches the tracker's per-parallel spread, and **adds confidence tags the tracker doesn't have.**

**Data honesty (must surface in UI):** `has_full_economics=true` only on BASE editions (badge_editions is base-only). Parallel (`::`) rows carry **FMV + circulation only** — `low_ask/highest_offer/burned/locked` are NULL for them. Render parallels as "FMV $X (MEDIUM) · /25 minted" and show ask/offer/burn/lock only where `has_full_economics`. Do not render NULL as $0.

**Frontend to build:** enhance the existing rookies surface (or a new `/insights/rookie-board`) with the tracker's "Sets & Moments" pattern — per rookie, an expandable per-set table with a parallel sub-row each (Standard→Omega) showing FMV+confidence, and ask/avg/offer/burned/locked/circ where present. The same view sorted by `burned desc` / `burn_rate_pct desc` is the "Burn Rankings" tab (#2). Query `?player_name=eq.<name>&order=set_name,parallel_id` via a `/api/public/insights/*` route (view is anon-readable, so either direct PostgREST or service-role route). Run the `rpc-insights-qa` gate before deploy (sitemap, canonical, OG, drill-downs to `/nba-top-shot/edition/<external_id>`, brand tokens, freshness chip off `updated_at`).

**Revert:** `DROP VIEW public.topshot_rookie_edition_board;`

### Rolled back (do not look for it)
Built then dropped `topshot_rookie_collector_leaderboard_mv` + its pg_cron job `rpc-refresh-rookie-collector-lb` — see #1 below for why. No leftovers (`pg_matviews`/`cron.job` confirmed clean).

---

## BLOCKED — need data/infra RPC does not currently maintain

The tracker's three standout features all rest on a **complete on-chain ownership graph + an event log** that it gets from Dune. RPC does **not** maintain these. Concretely measured today: Cooper Flagg "Rookie Debut" has **1,149 circulating but `moments` holds owner data for only 8 distinct owners** (<1%). `wallet_moments_cache` is ~241 tracked wallets. `moments.owner_address` is last-trade-owner (shallow), not a full ownership snapshot.

### #1 Per-player collector leaderboard — BLOCKED on a complete ownership index
"Top holders of player X's moments." Built a `moments`-based MV; it produced a misleading board (top "collector" = 6 moments when reality is dozens), so it was dropped. **Unlock:** a comprehensive TopShot ownership index — either (a) a Dune query mirroring the tracker, surfaced through a proxy + cached table, or (b) a full-collection on-chain owner walk (extend the existing wallet-backfill / `snapshot-institutional-wallets` machinery from "big wallets" to "all owners"). Once a per-(edition, owner) ownership table exists, the leaderboard is a cheap MV (the dropped migration's SQL is a working template — re-key it onto the real ownership table).

### #4 Set completers (+ completion-over-time) — BLOCKED on the same ownership index
"N wallets completed Rookie Debut" + a completion-race curve. Counting completers requires every owner's full holdings (same gap as #1). The over-time curve additionally needs ownership **history** (RPC has no usable snapshot series — `topshot_ownership_snapshots` is 1 row). `check_set_completion(p_wallet)` exists (per-wallet) and is the per-set membership logic to invert once ownership is complete.

### #2 Live burn feed (per-tx ticker) — BLOCKED on a burn-event indexer
Burn data in RPC is **aggregate-only** (`badge_editions.burned`, `topshot_squeeze_board.burned`, rookie_index `total_burned`). There is no per-serial burn event with tx hash + timestamp. The tracker's ticker (player·parallel·serial·tx·time) needs an on-chain burn-event indexer (TopShot `MomentDestroyed` / burn-address transfers) → a `burn_events` table. **Burn *rankings* are already shipped** via `topshot_rookie_edition_board` (sort by burned/burn_rate); only the live per-burn ticker is blocked.

### #5 Rookie ladder + NBA stats/photos — BLOCKED on NBA data refresh
`nba_players` covers only **10 of 61** 2025 rookies and has **0 headshots**; `nba_player_projections` is per-game projections, not season averages; there's no draft-pick or ROY-ladder column. Matching the tracker's stat cards needs: refresh `nba_players` for the rookie cohort (name→`nba_stats_id`, enabling `cdn.nba.com/headshots/nba/latest/1040x760/<id>.png`), add a season-averages fetch (PPG/RPG/APG via `rpc-sports-proxy` → NBA API) + draft pick, on a cron. The rookie board can ship a **market-based ladder now** (rank `topshot_2025_rookie_index` by `gmv_30d`/squeeze) without the NBA layer — that part needs no new data.

---

## Suggested order
1. Ship the **per-parallel edition board** frontend (#3 + #2 rankings) — fully data-backed today, highest-value, the single best idea from the tracker, and RPC's per-parallel confidence-tagged FMV beats the tracker's raw averages.
2. Decide on the **ownership index** (Dune vs on-chain walk) — it's the one unlock for BOTH #1 and #4, the two marquee features. Cost/effort + cost-flat constraint is Trevor's call.
3. Burn-event indexer (#2 ticker) and NBA-data refresh (#5) are independent follow-ons.
