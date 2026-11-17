# Burn ticker (#2) + NBA rookie refresh (#5) — verified scope (2026-06-26, Claude Code)

The other two rookie-tracker surfaces. Both have a **Cloudflare Worker** in the data path, so the
first concrete step is a `wrangler` deploy (operator-gated per CLAUDE.md). Mechanisms are verified
below; this is the executable plan, not a research stub.

---

## #2 — Live burn ticker (per-tx feed)

**Status today:** burn data in RPC is aggregate-only (`badge_editions.burned`, the rookie board's
burn *rankings* already shipped 2026-06-26). There is **no per-serial burn event with tx + timestamp**.

**Mechanism — VERIFIED via Cadence MCP** against the live TopShot contract `0x0b2a3299cc857e29`:
```
access(all) event MomentDestroyed(id: UInt64)        // line 100 of TopShot.cdc — the burn signal
```
Full event type: `A.0b2a3299cc857e29.TopShot.MomentDestroyed`. Payload carries only the moment
`id` (== nft_id). (There is also a Cadence-1.0 `ResourceDestroyed` on the NFT resource, but
`MomentDestroyed` is the explicit, contract-level, indexable event — use it.)

**Build plan (3 pieces):**
1. **`burn_events` table** (migration / Cowork): `nft_id text, block_height bigint, tx_hash text,
   burned_at timestamptz, edition_external_id text NULL, serial_number int NULL, parallel_name text NULL,
   player_name text NULL, set_name text NULL`. PK `(tx_hash, nft_id)` (idempotent). Index `(burned_at desc)`.
   RLS on; expose to anon via a `security_invoker` VIEW (the public ticker reads the view, not the table).
2. **Event walker** — extend the existing `pack-events-ingest` worker (it already walks TopShot
   events via Flow REST with an `event_cursor`) OR add a sibling worker route. Walk
   `A.0b2a3299cc857e29.TopShot.MomentDestroyed` in ≤250-block ranges (Flow REST cap), capture
   `tx_hash` + `block_height` + sealed-block time. Persist a `burn_events` cursor row in `event_cursor`.
   **Gate: `wrangler deploy` (operator).**
3. **Enrichment** — resolve `nft_id → edition/serial/parallel/player/set` via `moments` + `wmc` +
   `topshot_moment_subeditions` (best-effort; many burned moments won't be in RPC's tracked set —
   show what resolves, leave the rest as bare nft_id, and `log()` the resolve rate). Honest coverage
   note in the UI: "resolved from indexed moments."

**Frontend:** a ticker panel on `/insights/rookie-board` (and/or the squeeze board) reading a
`/api/public/insights/burn-ticker` route over the view, ordered `burned_at desc`, rookie-cohort filter
optional. Same insights-qa gate as the rookie board.

**Priority:** LOW relative to ownership — burn *rankings* already ship; this is the live-feed garnish.

---

## #5 — NBA rookie stats + photos

**Status today (verified):**
- `nba_players` schema is READY: `nba_stats_id, headshot_url, full_name_normalized, current_team_abbr,
  position, jersey_number, is_active_2026, last_synced_at`.
- BUT `headshot_url` is **0-populated** and coverage is **10/61** rookies. Root cause: the only writers
  are `sync-nba-projections` (auto-INSERTs players that appear on a **DraftKings** slate) and
  `match-topshot-players` (aliases). DraftKings supplies neither `nba_stats_id` nor headshots, and a
  rookie only lands in `nba_players` once they're on a DK projection slate — hence the gaps.
- The data RPC needs (`nba_stats_id` → `cdn.nba.com/headshots/nba/latest/1040x760/<id>.png`, season
  averages, draft pick) comes from **stats.nba.com**, which is NOT wired. `workers/sports-proxy` only
  has `/nba/draftkings-projections`, `/nba/scoreboard` (passthrough), `/nba/odds` (501 placeholder).
  See `docs/nba-pipelines.md`.

**Build plan:**
1. **New `sports-proxy` route `/nba/players`** (extend `workers/sports-proxy/index.ts`) → resolve the
   rookie cohort against a stats.nba.com roster endpoint (`commonallplayers?Season=2025-26&IsOnlyCurrentSeason=1`
   gives `personId` + team; `leaguedashplayerstats` for season averages). **stats.nba.com is bot-hostile**
   — needs browser-like headers (`Referer: https://www.nba.com/`, `User-Agent`, `x-nba-stats-origin: stats`,
   `x-nba-stats-token: true`) and may rate-limit; **validate through the worker before building the writer.**
   **Gate: `wrangler deploy` (operator) + an external-API validation run.**
2. **Sync function/cron** — for each name in `topshot_2025_rookie_players`, resolve `nba_stats_id` via the
   new route, set `headshot_url = 'https://cdn.nba.com/headshots/nba/latest/1040x760/' || nba_stats_id || '.png'`
   (deterministic — no extra fetch), optionally write season averages to a new
   `nba_player_season_stats` table + draft pick. Mirror the `sync-nba-projections` edge-function pattern
   (service-role, `Bearer INGEST`, `log_pipeline_run`, `X-Proxy-Secret: SPORTS_PROXY_SECRET`).
3. **Frontend:** add headshots + a stat line to the rookie board player cards (and the existing
   `/insights/rookies` index). The **market-based ladder already ships** (`/insights/rookies` ranks by
   `gmv_30d`) — this is the stats/photo enrichment layer on top.

**Priority:** MEDIUM — photos materially lift the rookie surfaces; the stats.nba.com integration is the
real work (and the validation risk).

---

## Why these are handed off, not shipped this session
Both put a **Cloudflare Worker change on the critical path** (`MomentDestroyed` event walker for #2;
`/nba/players` stats.nba.com route for #5), and worker deploys are operator-gated (`wrangler`, per
CLAUDE.md). #5 additionally can't be validated without deploying against bot-hostile stats.nba.com.
Mechanisms are verified so the next focused pass executes directly. Shipped this session instead: the
Rookie Board (`/insights/rookie-board`, live) and Ownership Pipeline A (Dune, inert until provisioned).
