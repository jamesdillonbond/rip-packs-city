# Daytime monitor — Dapper "degraded / can't buy" notice stuck on Top Shot while Top Shot is trading live

**Filed:** 2026-10-29 ~06:13Z (daytime health monitor) · **Priority: HIGH (user-facing accuracy, flagship collection) — blast radius limited, see risk read** · not a spell (io_wait 1 / active 3)

## What
`v_collection_marketplace_status` shows **degraded** for `nba_top_shot`, `nfl_all_day`, `disney_pinnacle`
(`last_verified_at` 2026-10-29 **02:59:44Z**) with the Dapper-maintenance notice: *"Dapper's marketplace is
still coming back from maintenance … most can't be bought until trading is back; this notice clears itself
when it is."* But that is no longer true for Top Shot:

- **Top Shot is trading live:** `sales` ⋈ `collections` — **10 Top Shot sales in the last 70 min, newest
  06:00Z (~12 min before this read).**
- **`atlas-market-feed` has been solidly healthy for over an hour:** continuous `ok=true` with 500–600
  rows/tick every 2 min since **05:11Z** (the last `ok=false` was 05:09Z; the sparse earlier falses are the
  normal ~5–15% Cloudflare 403 base rate). Trust health `topshot_fmv_stale_hours` 0.2 (fresh).
- **The auto-lift is firing but not clearing it:** `dapper-maintenance-notice-restore` (pg_cron, active,
  `7,17,27,37,47,57 * * * *`) ran and **succeeded** at 05:17/05:27/05:37/05:47/05:57/06:07Z (each "1 row"),
  yet the notice still reads degraded and `last_verified_at` is stuck at 02:59Z.
- **This is a FLAP, not the original outage:** the 10-29 00:15Z monitor filing recorded the notice
  *correctly auto-lifting* to healthy ~00:16Z, and 03:14Z saw atlas healthy. So Dapper recovered (~00:10Z,
  notice lifted) → re-degraded by 02:59Z → recovered again ~05:11Z, and this latest stable leg has NOT
  re-lifted. The restore mechanism demonstrably works (it lifted 6 h ago); something about this leg is
  gating it.

`buy_ctas_enabled = true` on all three rows (buy buttons are actually shown), so the notice copy
("most can't be bought") now contradicts both the live book and the site's own CTAs for Top Shot.

## Source
`v_collection_marketplace_status` (degraded rows + notes + last_verified_at) · `pipeline_runs` atlas-market-feed
2 h minute-by-minute timeline · `sales ⋈ collections` newest-sale per collection · `cron.job` +
`cron.job_run_details` for `dapper-maintenance-notice-restore` (only Dapper/marketplace cron that exists — no
companion "set-degraded" job) · prior filings `2026-10-29T0015Z-…` and `2026-10-29T0314Z-…`.

## Risk read
Correctness-safe for FMV/portfolio (unaffected, and the notice says so). **The harm is a stale, now-false
trust signal on the flagship collection**: Top Shot shows "most can't be bought until trading is back" while
10 sales just cleared and buy CTAs are live — contradictory and mildly trust-eroding during active hours.
Limited by: buy CTAs are enabled (not actually blocked), and a hard backstop in `restore_dapper_maintenance_notice`
lifts the notice unconditionally by ~12 AM PT 10-30 (≈07:00Z 10-30). All Day / Pinnacle had **0 sales in 24 h**,
so their degraded notice is more defensible (lower-volume / trading status genuinely less clear) — this finding
is scoped primarily to Top Shot.

## Suggested action (night pass / Trevor — monitor is sense-only, did NOT act)
1. Read the lift predicate in `restore_dapper_maintenance_notice()` and why it returns "1 row" without
   flipping `nba_top_shot` to healthy despite 60+ min of clean `atlas-market-feed` + live sales (candidates:
   a sustained-window counter the 02:59Z re-degrade reset; a per-collection gate; or a manual/override pin
   written at 02:59Z that the restore path respects).
2. Determine **what wrote degraded at 02:59:44Z** — no set-degraded cron exists, so it was a session, an API
   route, or the restore fn's own set-path. If it was a deliberate conservative pin, confirm that's intended;
   otherwise the lift is simply not matching this recovery shape.
3. Fastest user-facing fix if trading is confirmed live: flip `nba_top_shot` (and verify All Day/Pinnacle
   independently) to healthy now rather than waiting ~25 h for the backstop.

Do NOT heavy-probe Dapper directly (proxy-only, and sense-only here). Re-verify next tick: if the notice has
self-cleared, close this.
