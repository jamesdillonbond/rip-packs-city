# Overnight autonomous pass — 2026-11-26 (~1:05 AM PT)

**Verdict: GREEN. 0 shipped (quiet-and-honest night). 0 reverts. Ship budget untouched.**
Cowork cloud, laptop-VM `blob:none` clone + `.rpc-git-cred` push (dry-run exit 0, Everything up-to-date). Not frozen. Lock was RELEASED (prior rpc-nightly a885f7d4, pushed dc3a02454); taken over as run id 63a86f0f.

## Gates
- **Clock — no skew.** shell `date -u` 09:02Z / device 09:02Z / DB `now()` 09:02:34Z / newest sale 08:56:22Z / newest FMV 08:53:55Z — all within ~6 min, so no sandbox clock skew. Real local time ~1:02 AM PT = genuine overnight window; normal shipping allowed.
- **Lock:** `docs/overnight/.lock` was `RELEASED` (mtime 11-25 09:13Z, >24 h). Took over; marked RELEASED at end.
- **FREEZE:** absent.
- **Push:** AVAILABLE — laptop-VM `.rpc-git-cred` `push --dry-run origin main` exit 0. Normal (not NO-PUSH) mode.
- **Collision gate:** origin/main = `90cfd0d20` at run start; re-fetched before writing — no advance. Local HEAD = origin/main.

## Reviewed
- CLAUDE.md (full), ledger (headings + Declined + no-ship convention), 2 new inbox items, `docs/overnight/focus.md`, metrics-latest.json (11-25), latest handoffs.
- Health: `rpc_ops_snapshot()` baseline + independent security catalog SQL + CI/prod post-ship watch + runtime errors + client_error beacon.

## Inbox dispositions (2 new since the 11-25 ~1:05 AM pass; inbox left untouched — append-only)
1. **`2026-11-26T0405Z` — candy-edition-holders MV refresh one 03:33Z statement timeout → ONE-OFF TRANSIENT, closed.** `rpc-refresh-candy-edition-holders` (`REFRESH MATERIALIZED VIEW mv_candy_edition_holders`, `33 */3`) failed once at 2026-11-26 03:33Z (ran 120.1 s, hit the role default `statement_timeout`). The next tick (06:33Z / 22:33 PT) **succeeded in 35.4 s**; surrounding ~26 h of ticks all healthy (29–58 s). IO-wait was 0 at read time (per the filing's positive control) so not saturation collateral; the MV refresh is idempotent so no data lost. Per the inbox's own rule (give it headroom only if the timeout recurs on ≥2 of the next ~8 ticks) and measurement discipline (don't act on one run), **no change shipped.** If a second timeout lands within the next few ticks, the cheap additive fix is a `SET LOCAL statement_timeout` headroom on that one bare REFRESH (the MV has grown 21,510 → 21,549 keys).
2. **`2026-11-26T0432Z` — held DELETE of two stale zero-yield suppressions → CARRIED (attended-only).** Claude Code's `apply_migration` held the DELETE of `pipeline_zero_yield_suppressions` rows (`ufc-enrichment-drain`, `pack-pull-source-rip-id-backfill`) for confirmation and the unattended prompt timed out; nothing changed. Each row's own re-check condition is met (both lanes write again). **Left for an attended session (SQL editor or attended `apply_migration`):** it is a DELETE, the confirmation dialog times out the same way in this unattended cloud session, and the inbox itself notes neither lane is flagged today — no current Sentinel reading changes, so no urgency. Ready SQL + verify + revert are in the filing (name `audit_20261125_retire_two_stale_zero_yield_suppressions`).

## Health-drift findings + deltas
- **Security:** clean on all 4 snapshot arms AND independently via direct catalog SQL — `pg_tables rowsecurity=false` in public = 0; anon/authenticated INSERT/UPDATE/DELETE/TRUNCATE grant on an RLS-off table = 0. All 6 drift arms [] (search_path, procedure txn-control, cursor-rewind, suppression-parked, suppression-count, cross-collection-mat).
- **Trust:** 43/43 ok, 0 breaches, no UNKNOWN. (topshot_wmc_null_edition_key 0, ufc_wmc_null_edition_key_aged 0, fmv_sanity_flags 0, topshot_impossible_parallel_serials 0, panini_sale_field_mapping_shortfall −58/ok, candy_sales_stale 1 h, fmv_sweep_stall_pct_24h 4/ok, edition_integrity_flags 8/ok.)
- **Pipelines:** `stalled_pipelines` []. **No medium/high alerts** — last night's one medium (`gha-schedule-watchdog`) self-cleared and is absent this sweep. 8 info alerts, all Atlas/Dapper Cloudflare-403 base-rate (edition dispatch 7/480, market-feed 7/539, pack-supply 2/142, pack-book 19/701, pack-identity 5, on-demand 3 w/311 200s, pack-pulls 1 w/44 200s) + flow-rest moved-moment 400 (55/2036 panic:no_nft, designed). Each names its freshness escalation trigger and none is met.
- **Pipeline fails 24h:** all low. refresh_wmc_fmv_changed 6 (pre-fix residue — see post-ship watch), gha-schedule-watchdog 3, ts-sold-floor-clear 3, snapshot-pack-asks 3 (upstream 3), candy-listings-indexer 2, atlas-pack-market 2, candy-chain-sales 2, rest ≤1.
- **Sentinel:** `sentinel_ts_uuid_editions_48h` 0, `ts_uuid_dupes_created_24h` 0. (Sentry dark since 08-18, #34.)
- **Vercel runtime (18 h):** 15 groups, all the chronic honest read-timeout degradations (set-activity, profile/top-movers RPC timeout, squeeze / pack-sniper / rookies / trophies / trade-in initial-fetch 8000 ms, market_bundle, pack-detail ev_contributors, franchise-hub panel), counts 1–4, spread across many deploys, all via the honest "degrading to empty" / "read exceeded" helpers. **No pinnacle-image MODULE_NOT_FOUND in the window** (see post-ship watch) and no new cluster attributable to the evening wave.
- **Deltas vs 11-25:** db 58,778 → 59,763 MB (+985, routine). Trust breaches 0 → 0. FMV HIGH+MED: nba 7,214 → 7,218, panini 24,428 → 24,711 (+283), nfl 1,839 → 1,820 (−19), pinnacle 913 → 880 (−33), candy 65 → 77 (+12), golazos 1, ufc 0. editions panini +344 (57,344 → 57,688), candy +36 (21,513 → 21,549), nba/nfl/golazos/ufc flat.

## Post-ship watch — large 11-25 evening Claude Code feature wave — CLEAN, 0 reverts
The 11-25 evening/overnight wave (attended Claude Code; ~20 ships 7–10 PM PT) covered: interactive Moment slab ON for everyone, Panini cards folded into the one Portfolio FMV + Saved Wallets tiles, UFC Aptos listings lane keyed per Moment, the pinnacle-image 3-variant store, Top Shot rip pricing + at-rip hydrator, several Sentinel-clearing cadence/zero-yield migrations, and concierge/Moment-slab copy fixes.
- **CI green** on HEAD `90cfd0d20` (30 success / 5 skipped, 0 real failures). The two code tips `8259bae86` and `b07a1d5b3` each show one `dom-smoke:cancelled` — the scheduled E2E DOM Smoke superseded by a newer run, expected/benign.
- **Prod** = `dpl_Bx7qEM128up1PLZjjoxZfFFYuaKk` = `90cfd0d20` READY (on the latest code commit; rollback candidate). The two most recent tips (`db19cc86e`, `33fabd71d` — docs-only) CANCELED via `ignoreCommand` (expected). No ERROR in the recent production list.
- **refresh_wmc_fmv_changed (20s-headroom fix `20261126033441`, applied ~7:45 PM PT 11-25): HOLDING.** 45 consecutive `ok=true` runs (every 5 min, 11-25 21:23 PT → 11-26 01:03 PT, durations 0.1–17.2 s, 0 errors). The 6 fails in the 24 h count are pre-fix residue (the 04:13/04:18Z deadlock+lock-timeout pair + earlier 30 s route timeouts), not a regression. Target metric to re-check: fails stay ~0/24 h and no trust breach.
- **3D slab ON for everyone — client-side: CLEAN.** `usage_events.client_error` beacon = [] over 18 h (the only instrument that sees client-only failures; Sentry dark). No slab-related client regression.
- **pinnacle-image MODULE_NOT_FOUND — focus steer 11-26 verification PASSES.** 0 `/api/public/pinnacle-image/[renderId]` MODULE_NOT_FOUND groups in the 8 PM–1 AM PT window (vs 4 occ last night). The `20261125155001` signed-URL store + `90cfd0d20` (store all three variants, refresh-ahead) are holding. `pinnacle_render_floor_stale` 1.3 h/ok, `pinnacle_fmv_stale` 1.5 h/ok.
- No regression on any shipped item → **no auto-revert.**

## SHIPPED
None. 0 production-affecting changes.

## QUEUED (for Trevor / owner) — carried, each low
1. **refresh_wmc_fmv_changed SKIP-LOCKED extension — DECLINED 11-25 (keep as-is).** Prior attended analysis: unlike `resync_stuck_wmc_fmv`, this writer records `rwfc_applied` in the same statement as the wmc UPDATE, so SKIP LOCKED would mark skipped holders applied and strand them on a stale price. Rollback-and-retry is correct. Now reinforced: 45 consecutive post-`20261126033441` runs clean. Acceptable while ~≤6/24 h and no trust breach.
2. **Held DELETE — two stale zero-yield suppressions (inbox `2026-11-26T0432Z`).** Attended apply only (SQL editor or attended `apply_migration`). No current impact; re-arms the Zero-Yield arm on two lanes that are live again. Ready SQL + revert in the filing.
3. **pinnacle-image `/_next/image` MODULE_NOT_FOUND (observation, trending to closed).** 0 in tonight's window after the 11-25 store fixes; keep watching the 8 PM–1 AM window. Reopen only if Pinnacle OG cards render without art.

## FAILED / BLOCKED / REVERTED
None.

## Continuity
- Ledger: one entry prepended (this pass).
- metrics-latest.json: overwritten with tonight's values.
- inbox/: untouched (append-only; dispositions above).
- Session log: one entry prepended to `docs/sessions/2026-11.md`.
- Lock: released.
