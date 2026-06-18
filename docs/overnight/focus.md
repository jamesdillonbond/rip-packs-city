# Focus — night of 2026-06-18 → 06-19

Written by the 2026-06-18 interactive Cowork session (full platform audit + fixes, at Trevor's request), updated after Claude Code shipped the handoff. Platform GREEN: security 0/0/0/0, trust-health 9/9, pipeline fails 0.14%/24h, FMV reconciles exactly to edition counts, **no cross-parallel / cross-collection pollution** (verified data-layer + live). Audit: docs/audits/full-platform-audit-2026-06-18.md. Roadmap: docs/roadmap-2026-06.md.

Handoffs for CC (route/.tsx — NOT night-pass-shippable): (1) docs/handoff-2026-06-18-audit-followups.md — all 4 items SHIPPED ✓; (2) docs/handoff-2026-06-18-next-batch.md — AllDay deal-alerts extension + FMV recalc-throughput + alerts go-live checklist; (3) docs/handoff-2026-06-18-profile-data-bugs.md — the PUBLIC profile shows ~4× inflated moment/cost-basis counts + a fake −79% P/L. **Monitor/night-pass: this profile over-count is ALREADY DIAGNOSED (root cause = the profile routes collection-breakdown/cost-basis-summary/tier-breakdown not deduping get_user_saved_wallets' per-collection rows) and handed to CC — do NOT re-flag it as a new incident.**

## SHIPPED 2026-06-18 — POST-SHIP WATCH ONLY (do NOT re-queue / re-touch / auto-revert)

All ledger-logged with revert paths (CC updated ledger.md + CLAUDE.md). Prod d5f5f40 READY.

1. **BUYERBF batch 200→150** (route.ts:25; CC) — clears the ~577s-vs-600s silent-lambda-kill ceiling. Watch: the first post-deploy `topshot-buyer-backfill` run should log ~435s (runs at 14:44Z/17:24Z were ~530s, still pre/at-deploy). Confirm it keeps `ok=true` and never logs >600s or stops logging. Do NOT auto-revert on the 90m silent flag — known long-run drain.
2. **dispatch_due_deal_alerts 0-active-sub early-exit** (migration `audit_20260618_dispatch_due_deal_alerts_zero_sub_early_exit`; CC) — verified: returns `skipped:'no_active_subscriptions'` instantly, security clean. Watch: `alerts-dispatch` deal-leg timeout fails should stop. SCALE PATH — **DONE** (later 06-18 CC, see next-batch section below): fn statement_timeout 45s→90s + route maxDuration 60→120. Board caching not needed (full 3-leg build ~2.6s calm).
3. **normalize_pinnacle_edition() de-double-encode hardening** (migration `audit_20260618_normalize_pinnacle_edition_de_double_encode`; CC) + the Cowork one-time fix (`audit_20260618_pinnacle_editions_fix_double_encoded_mojibake`). Verified: board-wide mojibake = 0; future re-ingest self-heals. Do NOT touch pinnacle_editions.
4. **/insights/underpriced-serials staleness caption** (client.tsx; CC) — surfaces ingest lag honestly. See operator item below.

## SHIPPED 2026-06-18 (later, CC) — next-batch + profile data bugs (POST-SHIP WATCH; do NOT re-queue)

Commits `80100c1` (profile), `dd7e2bf` (alerts) + 2 migrations (applied live). Both handoffs (next-batch §A/§B + profile-data-bugs) drained. tsc-clean on changed files; nothing touches FMV writer logic / auth / secrets.

5. **Profile data bugs (`80100c1`)** — `get_user_saved_wallets` returns one row per (wallet × published collection), so the profile aggregation routes summed each wallet ~4×. Deduped collection-breakdown / cost-basis-summary / tier-breakdown / top-movers. Also: single-@ handle, `#0` serial chip suppressed on /insights/top-sales, /share TS-moment caption reconciled to the per-collection card source. **FINDING (needs Trevor's product/privacy call, NOT shipped):** these three cards are *viewer-scoped* (routes auth-gate to the logged-in user, ignore `ownerKey`), so on a public profile viewed by anon/non-owner they show empty or the viewer's own data — that's the real reason "Top Movers" reads empty. Owner-scoping (resolve by username) would make them show the profile owner's data but turns cost-basis "Total Spent" public; CostBasisCard already gates P/L to `ownView`. Decide before owner-scoping.
6. **§B AllDay deal board leg + UI** (`dd7e2bf` + migration `audit_20260618_allday_deal_board_leg`) — new security_invoker view `allday_edition_floor_ask` (min active, non-expired floor ask per edition) + a 3rd UNION leg on `cross_collection_deals_board` (nfl_all_day: floor vs latest HIGH/MEDIUM FMV). Board: TS 607 / Pinnacle 23 / **NFL All Day 159**. /alerts Collections multiselect gains NFL All Day. Security invariants clean (0/0). Revert: `CREATE OR REPLACE VIEW cross_collection_deals_board` without the AllDay leg + `DROP VIEW allday_edition_floor_ask`; remove the UI option.
7. **§A scale path** (`dd7e2bf` + migration `audit_20260618_dispatch_due_deal_alerts_timeout_90s`) — `dispatch_due_deal_alerts` statement_timeout 45s→90s, `alerts-dispatch` route maxDuration 60→120. Revert: `ALTER FUNCTION ... SET statement_timeout TO '45s'` + route back to 60.

## OPERATOR ITEMS (Trevor / infra — can't be done in-session)

- **Atlas residential runner overnight schedule** — confirm/repair so the underpriced-serials board refreshes ~3-hourly around the clock (the new caption now shows the lag when it skips).
- **§D FMV recalc throughput** (handoff next-batch §D) — throughput-bound, NOT a writer-logic change. Targeted re-price set (measured 06-18): **498 TS STALE editions with ≥1 sale/30d** (124 with ≥3) + **2,675 TS LOW editions with ≥3 sales/30d** — these are mislabeled/under-escalated only because the recalc cursor hasn't reached them. Lever: raise the "RPC FMV Recalc Force Stale" cron-job.org cadence and/or run a targeted fmv-recalc pass over that union (moves TS HIGH+MED up from ~3,122). COMMON-#1 coarse refinement: CONFIRMED already correct — `topshot_underpriced_serials_board.estimate_quality` marks COMMON #1 (serial 1, not last-mint) `'coarse'` via the `(serial=circ OR tier<>COMMON)` gate, and Pass-2 only enqueues `'tight'`; no double-counting, no change.
- **Alerts go-live test** (handoff next-batch §A) — pipes are live (alerts-dispatch/alerts-send running, all 3 channels verified, 0 subs). Create an alert via /alerts, confirm a digest lands on each channel, then decide on opening to the allow-list. The §A scale path is now applied.

## STEER — do NOT re-flag these

- **SERIAL-FMV-MULT-CRON — BY DESIGN.** `serial_fmv_multipliers` (37 cells) AND `serial_fmv_power_model` (5 segments) refresh **weekly** via pg_cron (jobs 5+6, both active, Sun 11:00). Staleness ≤7d is expected. Do NOT re-queue as an escalating cron-silent item — reclassify/close.
- **evm-transfers-ingest Base-429** — benign off-to-the-side EVM/Beezie indexer (Base RPC rate-limit). Don't chase.
