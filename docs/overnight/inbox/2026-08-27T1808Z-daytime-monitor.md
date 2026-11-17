# Daytime monitor candidates — 2026-08-27 ~11:08 PT / 18:08Z

Source: rpc-daytime-monitor mid-day tick. **NOT in a spell now** — positive control
io_wait=3 / active=3 / total=43 at 18:06Z, and `rpc_ops_snapshot()` returned fast (did not
time out). Security clean (invariants/anon-write-holes/secdef-anon all `[]`; 0 RLS-off public
tables). Vercel: latest production deploy `078ca5d8` (telemetry `after()` fix) **READY**, zero
ERROR in the recent list. Sentinel TS UUID edition-writer leak 48h = **0**. Artifacts: 11
active; `rpc-live-health` payload validated by backing-relation existence check — all 22
relations + `get_pipeline_alerts()` present, **no schema break** from today's route/proxy ships.
Editions TS 19,892 / AllDay 6,190 / Golazos 575 / UFC 518 / Candy 125 (27,300). DB 14,032 MB.
FMV HIGH+MED: TS 7,595 / AllDay 1,578 / Golazos 2 / UFC 0 (Pinnacle own path, healthy).

**Trust health: 5 breaches, all known/explained — nothing new-broken.**
`public_board_slow_count`=6 (was 7 overnight; #27 IO-saturation class) ·
`unmapped_resolution_backlog_max`=374 (was 357; AllDay structural residual, net-draining) ·
plus the two candy_offers legs and fmv_sweep_wedge covered below.

**pg_cron:** a cluster of `statement timeout` failures on MV-refresh jobs at 12:20–12:50Z
(`rpc-refresh-allday-pack-realized`, `-allday-pack-sales-agg`, `-topshot-pack-sales-agg`,
`-allday-ev-corrected-refresh`, `rpc-thp-leg-impossible-parallel`) — this is **past-window
saturation collateral, already cleared** (snapshot fast now, only 3 active sessions), the
board-MV 600s class (#27). No logic errors. `rpc-reconcile-saved-wallet-stats` 17:44Z is the
known designed soft-deadline bound. **Do not file these as N distinct bugs.**

## LOW / discriminate — candy standing-offer book went dark TODAY (both coverage legs at the 999 sentinel)
- Source: `rpc_ops_snapshot()` trust_health — `candy_offers_oldest_active_hours`=999 (breach 36)
  and `candy_offers_unverified_pct`=999 (breach 25). Both are the **no-data sentinel**.
- Measured 18:07Z: `candy_offers` **0 active**, `max(last_seen_at)` = 2026-08-27 06:51Z. The
  indexer is **healthy** — `candy-offers-indexer` last ran 12:50Z, **1 fail / 24h**. So the
  book emptied out after ~06:51Z today; the coverage arm (whose whole purpose is to catch the
  2026-08-05..08 three-day outage class) fires on an empty book because it cannot distinguish
  legit-empty from a break.
- Not in the overnight baseline (08:05Z) → **newly dark this morning**, but this metric is a
  **recurring** breach (filed on 08-14/15/16 daytime ticks). Sibling to the 08-26 candy-LISTINGS
  darkness filing, but a distinct feed (offers, not listings).
- Risk read: read-only to diagnose. Indexer health points to **legit-empty** (Magic Eden has no
  active Candy standing offers right now) rather than a break — but that is the exact call the
  arm can't make.
- Suggested action (night pass / Trevor): discriminate (a) ME genuinely returns 0 Candy offers
  vs (b) the indexer writes but the book-liveness read is wrong. Indexer at 1 fail/24h favours
  (a). If (a), the arm needs a legit-empty branch, not an alarm. **Do not auto-ship a guess.**

## LOW / symptom — re-measure: fmv-recalc silent since 13:29Z (~4.6h, past its 120m threshold)
- Source: `detect_stalled_pipelines()` (fmv-recalc, 278 min silent) + `fmv_sweep_wedge_hours`=6.33
  (breach 3). Last two runs 12:48Z and 13:29Z **failed** (inside the saturation window above),
  then nothing since.
- ⚠ **This is a SYMPTOM, not a freshness break.** `topshot_fmv_stale_hours`=0.1 (fresh) and
  `topshot_fmv_pct_stale_30d`=0 — FMVs are still being written, so the catalogue-sweep gap is the
  documented **wasteful-not-broken** class amplified by the 12:20–12:50Z spell, not a stall of
  the price surface.
- Suggested action: **re-measure in a quiet window** — confirm fmv-recalc resumed firing on its
  ~18m cadence. Genuine finding ONLY if it stays silent AND `topshot_fmv_stale_hours` climbs.
  Do not raise a timeout; do not reach for the 08-03 page-zero fix (that path is proven working).

---
_Inbox written to mount, push unavailable (NO-PUSH cloud session: no `remote.origin.pushurl`,
`git push --dry-run` → "could not read Username"). The night pass will pick it up locally._
