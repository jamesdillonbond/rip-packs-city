> ## ✅ RESOLVED 2026-08-30 15:5x PT (Claude Code, Trevor's box) — Candidate 1 actioned as (b), and **option (a) is REFUTED by measurement**
>
> ⛔ **DO NOT land the depletion leg expecting this board to repopulate.** The filing's two premises
> are both wrong, and the night pass should not re-derive them:
>
> 1. **"A writer has revived"** — no. The 10 positive-EV rows are all at minute **:13** = pg_cron
>    **jobid 71 `backfill_topshot_historical_pack_ev`**, a HISTORICAL reconstruction job that has
>    been running all along. The filing considered only the atlas `:25` writer and the dead edge fn.
>    Those rows carry NULL `price_source`, NULL `total_unopened` **and** NULL `depletion_pct` — there
>    is no evidence any of those packs is still buyable, so publishing them would be wrong-not-empty.
> 2. **"One NULL-handling default suppresses 100% of it"** — the NULL is a symptom, not the cause.
>    The live writer (**jobid 217 `rpc-atlas-pack-ev`, :25**) is HEALTHY and wrote 56 Top Shot rows
>    today with `price_source` and `total_unopened` populated, avg `fmv_coverage_pct` **100.0**, and
>    `pack_ev` from **-892.87 to -1.65 — zero positive**. **The board is empty because no live Top
>    Shot pack is +EV.** Giving the historical rows a depletion value would not change that.
>
> ⓘ Also corrected: "the depletion COMPUTATION stopped" is Top-Shot-scoped, not global. On 08-30
> `nfl_all_day` 1279/1279, `laliga_golazos` 130/130 and `disney_pinnacle` 91/91 have depletion fully
> populated; only `nba_top_shot` reads 0/148.
>
> **Shipped: option (b).** `public_board_liveness_watchlist.topshot_pack_reality_top_ev` →
> `is_active = false` with a reason naming the re-activation condition
> (`supabase/migrations/20260830225125_audit_20260830_deactivate_pack_reality_top_ev_liveness_arm.sql`).
> Breaching active arms went **1 → 0**. ⚠ Not a blind silencing: `topshot_pack_reality_dist` (6 rows)
> and `topshot_pack_reality_stats` (1 row) stay ACTIVE and healthy, so a genuine pack-reality break
> still pages. The ⛔ against relaxing `COALESCE(depletion_pct,100) < 90` **stands and is reinforced**.

# Daytime monitor candidates — 2026-08-30T21:06Z (14:06 PT)

Context: NOT in a saturation spell at sweep time — `pg_stat_activity` IO-wait 0 / active 0 on
two probes ~6 min apart, and `rpc_ops_snapshot()` returned fast. The `check_pgcron_recent_failures()`
list carries ~10 `statement timeout` / `job startup timeout` failures clustered in the 08:xx and
18:1x–18:2x UTC bands (backfill-pinnacle-acquisitions, refresh-allday-pack-sales-agg,
remap-misattributed-sales, refresh-thin-fmv-guard, refresh-fmv-display-guard,
fmv-clamp-disconnected-ask, serial-fmv-jersey-weekly, allday-dedup-full-weekly,
backfill-pinnacle-mint-acquisitions, topshot-buyback-daily) — saturation collateral (Section 1c),
ONE spell not N bugs, same class as the ~14 ledger ship entries today. Not re-filing as distinct bugs.

## Candidate 1 (MEDIUM) — the `topshot_pack_reality_top_ev` PUBLIC board went DARK today ~16:38Z; positive-EV data now EXISTS again but all rows carry NULL depletion and are excluded by the view's `COALESCE(depletion_pct,100) < 90`

- **Source.** `rpc_ops_snapshot()` trust_health `public_board_empty_count` = 1 (BREACH, breach_at 1).
  `public_board_liveness_state` for `view_name = 'topshot_pack_reality_top_ev'` reads `row_count = 0`,
  `err = ''`, `elapsed_ms = 11` — the view runs clean and fast; this is a GENUINE empty, not a timeout.
  Confirmed live: `SELECT count(*) FROM topshot_pack_reality_top_ev` = 0.

- **What changed since the 15:10Z tick (which did NOT flag this breach).** The board reads
  `mv_topshot_pack_reality_top_ev` ← `pack_ev_latest` with `snapshotted_at >= now() - 48h`. The last
  pre-outage positive-EV rows were written **2026-08-28 16:38:02Z** (the instant
  `public-api.nbatopshot.com` died — see inbox/2026-08-30T0230Z). Those rows aged past the 48h window
  at **~2026-08-30 16:38Z**, ~4.5h before this sweep — so the board is dark for the first time this
  cycle, which is why the 08:10 PT first-tick run correctly did not see it.

- **New fact that REFINES inbox/2026-08-30T0230Z (the blocker has narrowed).** A writer has revived:
  `pack_ev_latest` now holds **10 fresh positive-EV Top Shot rows**, snapshotted 05:13–20:13Z today
  at hourly cadence, `price_source = NULL`, `fmv_coverage_pct = 100` — e.g. Holo Icon April (dist 1247,
  EV $439), 2024 NBA Finals Legendary (dist 1473, EV $143), Freshman Gems (dist 1089, EV $59), four
  Got Game drops. **Every one has `depletion_pct = NULL`**, so `COALESCE(depletion_pct,100) < 90`
  excludes all 10 (100 < 90 is false). `total_unopened` is still populated; the daily populated-count
  fell 319/439 (08-28) → 0/148 (08-30), so it is the depletion COMPUTATION that stopped, not the input.
  The board's blocker has therefore moved from *"no positive-EV data at all"* (the 0230Z state) to
  *"positive-EV data exists but one NULL-handling default suppresses 100% of it."*

- **This is the honest-by-design outcome the 0230Z filing predicted** ("the board stays empty rather
  than wrong … until the depletion leg exists"). No false claim ships — empty-not-wrong. **But the
  standing conflict is now live and will BREACH continuously:** the liveness watchlist carries
  `topshot_pack_reality_top_ev` as `is_active = TRUE`, while `candy_deals_board` and
  `topshot_underpriced_serials_board` — the other two "genuinely-can-be-empty market boards" — are
  carried `is_active = FALSE` WITH a stated reason precisely so they don't page on honest emptiness.

- **Risk.** None from the board itself (empty, not wrong). The cost is (a) a permanent trust-board
  BREACH that will mask the next genuinely-dark public board, and (b) real revived EV that users
  cannot see on the public surface.

- **Suggested action (night pass / Trevor — this is a DECISION, not a blind fix; quiet-window verify
  the revived-writer identity first, since `price_source = NULL` does not match either the atlas `:25`
  writer or the dead edge fn).** EITHER (a) land the depletion leg per 0230Z (on-chain pack-opens per
  dist against last-known minted total) so revived rows carry real depletion and the board repopulates;
  OR (b) if depletion stays unknown for now, carry `topshot_pack_reality_top_ev` as `is_active = FALSE`
  in `public_board_liveness_watchlist` with a "supply-unknown, dark-by-design" reason — matching the
  candy_deals / underpriced_serials precedent — so the arm stops crying wolf.
  ⛔ **Do NOT relax the view's `COALESCE(depletion_pct,100) < 90` to admit NULL-depletion packs onto a
  PUBLIC EV board** — that publishes possibly-sold-out packs as buyable +EV, the exact wrong-not-empty
  failure the guard exists to prevent.

## Not filed (already tracked / expected — listed so the night pass sees they were considered)
- Trust breach `unmapped_resolution_backlog_max` = 294 — chronic AllDay permanent-unresolvable
  residual; do-not-raise-breach_at; the view's own `catches` text says it reads BREACH as an honest
  open finding. Known.
- Pipeline alerts fmv-backfill 71.4%, price-snapshots 50%, populate-pinnacle-wmc-fmv 29.9%,
  snapshot-institutional-wallets 40%, topshot-active-listings-ingest 37.5% — the last is `egress_blocked`
  on the GHA arm only (residential arm 100% ok per inbox/2026-08-30T1610Z); the rest are saturation-band
  statement-timeout collateral. Known.
- `match-topshot-players` running_but_not_succeeding (0 ok / 0 rows, last 08:00Z) — known no-op (#54),
  `nba_players` 174-row partial load, zero user-facing impact. Known.
- Top Shot legacy-endpoint outage (`public-api.nbatopshot.com` 530) + downstream topshot-* failures —
  known; Atlas migration queued for operator (inbox/2026-08-30T1610Z).
- Sentry dark since 08-18 — standing operator/billing blocker; not re-probed.

## Sweep coverage note
Security invariants / secdef_anon / rls_off_base / anon_write_holes all `[]` (clean).
`detect_stalled_pipelines()` = `[]`. Latest production Vercel deploy READY (spork-proxy reachability
floor, sha f633341). Artifacts NOT individually payload-validated this tick — they live on Windows
paths and a full session-tree find timed out at the 120s cap — but the backing data layer they read
(rpc_ops_snapshot, check_pgcron_recent_failures, the board-liveness tables, security catalog reads)
all returned successfully, so no schema break surfaced.

---
_inbox written to mount, push unavailable (remote.origin.pushurl empty — the dead desktop harvest;
remote.origin.url is bare-public; `git push --dry-run` fails on no credential). Night pass picks this
up locally._
