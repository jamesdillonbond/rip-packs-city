# Daytime monitor — 2026-11-16 ~19:10Z (17-ish hour tick; read-only health sweep)

Platform GREEN. Security clean (all 4 arms []), no stalled pipelines, pg_cron clean,
13/13 live dashboards' SQL objects resolve, Vercel prod READY at HEAD d719c46, no new
runtime-error class, client-error beacon 1/24h. One trust breach, below — expected drop-day
behavior, actionable by the night pass. One new candidate.

## Candidate 1 (MEDIUM) — seed description recipes for the two new Top Shot WNBA Finals containers so they get Rip EV

- **Title:** `topshot_container_missing_recipe_count` = 2 — "WNBA Finals Box" (dist 8934) and
  "WNBA Finals Case" (dist 8933) are new Top Shot containers with no `pack_container_recipes`
  row, so `refresh_container_pack_ev` prices them at nothing and the box/case pages show no Rip EV.
- **Source:** trust arm `topshot_container_missing_recipe_count` (v_rpc_trust_health, breach_at 1,
  value 2); both dists `first_seen_at` 2026-11-16 18:25Z (~0.7 h before this sweep); both carry a
  non-empty `metadata.description` (119 / 99 chars) in `pack_distributions`
  (collection_id `95f28a17-224a-4025-96ad-adf8a4c63bfd`).
- **Risk:** LOW. Data-only seed following the established template
  (migration `20261112144751`, Box 8917 / Case 8916 seeded the same way on 11-12). No schema
  change. Recipes are OBSERVED from opened containers, so an observed recipe replaces the seed
  on the first open. By-design breach, not a defect — this arm exists to surface exactly this.
- **Suggested action (night pass):** follow `docs/runbooks/topshot-box-case-drop-day.md`
  (find → seed a description recipe from Dapper's `metadata.description` with the
  slot/Moment-count DO check → price now via `refresh_container_pack_ev` → confirm on the
  scheduled :28 run → check the box/case page). If a description cannot be parsed into a
  pack-slot recipe, leave it (the 8426 Mega-Box precedent: no source, stays unseeded) and the
  arm clears when the drop ages past the 30-day window.
- **Not urgent / no push:** no user harm — the two new containers simply lack Rip EV until
  seeded or first-opened; the rest of the Top Shot surface is unaffected.

## Noted, NOT candidates (sweep context)

- `hybrid_custody_backfill` reads MEDIUM in `rpc_ops_snapshot.pipeline_alerts` (2/6 failed, 33%),
  but both failures are 2026-11-15 10:23Z / 10:33Z — before the 11-15 90 s fix (`20261115172736`).
  Last two runs (11-15 13:19Z, 11-16 13:19Z) ok=true. STALE pre-fix window; clears as the window rolls.
- Chronic Atlas Cloudflare `upstream-403/404` and `flow-rest-moment-moved-400` info rows — all
  attributed, fresh 200s, 0 catalog staleness. Known/by-design, not findings.
- `candy_sales_stale_hours` now ok (48.7 h, breach_at 730) — the 11-16 burnt-card resolution
  (`7c437d4da`) closed the `edition_not_ingested` leg that breached overnight.

## ✅ RESOLVED 2026-11-16 ~10:35 PM PT (Claude Code cloud, autonomous pass)

- Recipes seeded per the runbook: migration `20261117052750` (Box 8934 = Topper 8939 ×1 + Collector 8937 ×5 → 6 packs / 36 Moments; Case 8933 = Topper 8932 ×1 + Premium 8938 ×1 + Collector 8937 ×10 → 12 / 78; DO block reconciled both).
- **The containers still cannot price yet, and that exposed a second defect:** none of the drop's inner packs had a pool or EV, because `topshot_pack_supply_tick` read their summaries at 10:34 AM PT before any pack was minted and parked all nine dists for 30 days. Fixed `20261117053146` (a new unminted dist is re-read every 2 h); verified live at 9:35 PM PT — all nine re-read, next due ~11:35 PM PT. Container EV follows once the drop mints and the inner packs price.
