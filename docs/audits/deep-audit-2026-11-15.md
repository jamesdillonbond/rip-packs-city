# RPC monthly deep audit — 2026-11-15

Run by the scheduled Cowork deep-audit task, ~12:55–1:55 AM PT Sunday 11-15. HEAD at start `a1196b7c5`. No `docs/FREEZE.md`. Six read-only sweeps (A–F) ran as parallel subagents; triage, fixes and verification by the parent session. Every time below is Pacific.

**Verdict: no P0, no P1.** Security invariants all hold. The platform's public surfaces render honestly almost everywhere; the defects found are a false failure banner on one public board, a fabricated $0 bid column nobody currently renders, three slow Panini/analytics reads that intermittently fail at the 8 s `authenticator` timeout, and one handle-squatting gap in onboarding.

## Shipped this pass

| id | sev | what | revert |
|---|---|---|---|
| D1 | P2 | `/insights/candy-mlb` told every visitor its Holders tab was a "temporary database-load failure … reload shortly" while the read had SUCCEEDED and filled its 800-row cap (`candy_holder_board` 1,316 rows). `BoardStatus.capped` added; `summarizeDegraded` uses cap copy when nothing failed and every incomplete section is a declared cap; candy-board declares `capped` (its fetcher sets `truncated` only on a successful read). Panini's mid-walk failure path (`ok:false, partial:true`, no `capped`) keeps the failure copy — 3 new pins in `__tests__/insights-board-status.test.ts`. | revert the code commit |
| C2 | P2 | 3,213 of 5,607 All Day `badge_editions.highest_offer` = 0, 0 NULL (fabricated $0 bids). Writer `allday-badge-ingest` `?? null` → `|| null`; migration `20261115093610_audit_20261115_allday_badge_zero_offer_to_null` archived the 3,213 ids in `flowty_archive.audit_20261115_allday_zero_offer` and NULLed them. Post-check: zeros 0, archived 3,213. | SQL in the migration header; revert the code commit |

The holders ranking itself is still cut at 800 (PostgREST clamps at 1000 and the client table caps at 800) — now labelled honestly; paging it is a handoff item.

## Findings handed off (not shipped — see `docs/handoff-2026-11-15-deep-audit.md`)

| id | sev | finding | why not shipped |
|---|---|---|---|
| A-1 | P2 (INFERRED exploitability, VERIFIED path) | `POST /api/profile/resolve-and-associate` saves any wallet with no ownership proof and `claimUsernameFromTopShot` (`lib/profile/claim-username.ts:45`) then claims that wallet's Top Shot username as the caller's RPC handle, first come first served. Widened by `c082fea78` (11-03). Blast radius: impersonation on `/profile/<handle>`, trade-block and trophy boards; not a private-data leak (private routes key on `user.id`, #176). Canary: wallets saved by >1 user = **0** today. | touches the onboarding path the 11-05 signup cohort uses; needs a product call on what "proven" means for a first-run handle |
| D2 | P2 | `/panini-blockchain/market` default view 503s intermittently (4 of 8 curls ~1:21–1:27 AM): `panini_market_board` read exceeds the 8 s client timeout. 0.9 s direct, 4.2 s avg / 28 s worst through PostgREST. Honest error state. Measured under load (wmc autovacuum running) — INFERRED partly load-driven. | perf work (MV or narrower read) |
| D3 | P2 | `/insights/panini-premiums` fails cold 2 of 2: `panini_serial_premiums` view scans ~30.5k blocks of `panini_sales`, 7.6 s cold. Fix: hourly MV (page already `revalidate=3600`). | migration + refresh job design |
| D4 | P2 (recurrence) | `/api/analytics/health` 500s intermittently (function's own 5 s timeout; 163 ms direct, 1.7 s avg / 5.0 s worst via PostgREST). Same class as the 11-07/08 ledger "analytics group stalls". Badge says "Status unavailable" — honest. | already a known class |
| C1 | P2 | Candy/Panini players split by spelling: 5 Candy + 2 Panini real person pairs (Cal Ripken Jr / Jr. → `cal-ripken-jr` 5 of 16 editions and `cal-ripken-jr-` 11 of 16; C.J./CJ Abrams; Domínguez; García ⚠ may be two real people; Álvarez; P.J. Washington Jr.; Wang Zhi-zhi). ~0.6 % of Candy players. | merges are data-identity decisions (#139 pattern) |
| C3 | P2 | 66 TS `pack_ev_latest` rows with `gross_ev > 0` at `fmv_coverage_pct = 0` (April challenge-reward residue, 1 `is_positive_ev`). Not exposed — every public reader applies the 72 h + availability bar. | deletion needs approval |
| C4 | NOT-A-FINDING / alarm tuning | `v_rpc_trust_health.candy_sales_stale_hours` BREACH: the ">50 newly parked in 48 h" arm counts 2,045 deliberate `queued_collections_walk` rows from #257's history walk; the indexer itself ran 8/8 ok. Suggest excluding that skip reason. | changes an alarm's definition |
| B1 | P2 | `topshot_transfer_hop_stage` still v1-shaped (PK `(wallet,nft_id)`, 0 rows); nothing calls `?lane=hop`. Ledger 11-14 11:25 PM already awaits Trevor's approval of the reshape. | awaiting Trevor |
| B2 | P2 | Two finished #190 stage lanes (`47 * * * *`, `?lane=provenance` `52 * * * *`) still run hourly as `up_to_date` no-ops. Remove at vercel.json once #190 closes. | #190 still active in another session |
| E-1 | P2 | Edition page (`revalidate=600`) ISR-caches `<EditionUnavailable/>` on a failed read — same class as #249, on the largest indexable route; not in known-issues. | needs a preview-deploy render check |
| E-2 | P2 (tiny reach) | Concierge tools report a capped read's row count as `total` (`support-chat/route.ts:2826, :6185`, `candy-boards.ts:250`, `allday-boards.ts:172`). | low reach; bundle with next concierge pass |
| E-5 | open | #253 `panini-sale-feed-status-refresh` missed 3 of 33 hourly slots (11-13 8:14 PM, 11-14 6:14 PM, 8:14 PM) — one more since filing. | already filed |
| A-2 | P3 | 3 new `function_search_path_mutable` (`alert_sub_is_exact_serial`, `recent_low_usd`, `topshot_league_for`) — INVOKER, not anon-executable, pure SQL. Pinning blocks inlining; accept like R142 unless off a hot path. | inlining trade-off |
| F-1 | P2 (reporting) | `email_subscribers` reads 44 but holds **1** opt-in: 43 rows are unsubscribe-token shells for account holders (`lib/email/recipient-guards.ts:81`). Quote `verified AND unsubscribed_at IS NULL`. | docs |

Hygiene (E-3/E-4): 7 zero-reference exports added since 10-15; 6 new local HTML `esc()` copies (two skip `'`); `safeEqual` in 15 workers in two bodies. Brand: 2 new bare `#E03A2F` recharts strokes in `components/entity/FmvHistoryPlot.tsx:117,120` (`fac029a32`).

## Register re-measurements

| row | was | now | read |
|---|---|---|---|
| R146 | PARTLY (DB backstop owed) | CHECK `profile_bio_username_handle_shape` + unique `lower(username)` present, 0 of 61 bad | **RESOLVED** |
| R8 | open | 591 team moments all carry `player_name = team_name`; NULL player_name 0 | **RESOLVED** |
| R73 | "concierge answering nobody" | human opens 1→2→4→2→10 per week (10 from 5 people week of 11-09); 31 human messages / 10 sessions in 30 d | **premise superseded** — reach ~5 people/week, keep as a watch, not a defect |
| D21 | AllDay bid age median 9.08 d | 5.72 d over 2,309 rows | improved |
| E5 | 27 | 26 (the UFC route deletion, not a conversion; two retired UFC routes still listed) | shrank |
| R61 | false-document GHA crons | unchanged; 11 workflows ask >5/day, all but 3 carry the R61 comment; watchdog `scheduled_ticks_24h: 9` | holds |
| R65 | 10,483 lines / 38 fns | 11,649 / 47; `_shared/` imports 6 → 21 | lines grew, extraction improved |
| R59 | ~99 % machine sessions | 94.1 % `bot_ua`-flagged; 0.14 % of sessions do anything | holds |
| D8 | open | no wmc-only blanks left in any collection; Candy wmc is now a 1.37 M-row census (re-baseline its VERIFIED-CLEAN row) | effectively resolved |

## Traction (internal accounts excluded; definition `get_rpc_traction_activity()`)

Accounts 60 (10-15: 35). **WAU 36** (10-15: 6), MAU 41 (17). Signups 19 in 7 d, 24 in 30 d. The jump is the Dame Time cohort: 20 signups the week of 11-05, of whom 13 came back >24 h after signup and 7 have been active since 11-12. Current partial week (from Thu 11-12): WAU 16. **wallet_paste** (funnel_events): 96 in 30 d across 59 sessions (prior 30 d: 67); on the script instrument (`search-executed`) 258 from 32 browsers (10-15: 65 / 46). D7 return 0 of 4. Real opt-in email subscribers: **1** (unchanged). Trade room: 2 rooms ever, both internal, both cancelled — **0 outside use 15 days after launch**. Search referrals remain tiny (google 91 visitors / 30 d).

## Verified clean this pass (probes added to the register)

Security invariants 0 · anon write surface 0 · secdef drift 0 · RLS-off 0 of 796 · MV anon-readable 0 · view bypass 0 · anon EXECUTE 89 of 1,226 (all search_path pinned, 1 writer = INVOKER trigger, 7 SECDEF all allowlisted) · secret shapes on origin/main 0 · gate keys in `cron.job` 0 of 320 · IDOR: every write route in 376 changed `app/api` files gated (except A-1) · `v_pipeline_failure_rates` 0 rows · Vercel crons without observability 0 of 43 · pg_cron failures 7 d = statement/startup timeouts + "job canceled" on self-unscheduled jobids + 1 fixed COALESCE + 1 deadlock · FMV coverage of canonical editions 100 % in TS/AllDay/Golazos/UFC/Panini, Candy sold editions 610/610 · pack-EV honesty 0 fabricated / 0 stale-published · TS parallels 0 defects over 5,103 keys · badge zero asks 0 · `sets_summary` counts = live editions in all 6 collections · rendered DOM: 92 anonymous pages, 0 NaN/undefined, 0 FMV tiers shown, 0 gated redirects, 0 mobile overflow on 8 key pages at 390 px · SEO: 12 pages with self-canonical, valid JSON-LD, 200 og:image; sitemap index 9 children, largest 28,854 URLs · Vercel: 0 ERROR deploys since 11-05. Job 491 `rpc-ccm-step2-retry` inactive = deliberate pause since 09-13 (`20260913173902`).

## Overturned or superseded prior findings

R73's headline ("the concierge is answering nobody") no longer holds — it now reaches ~5 people a week. R8 resolved itself through the team-moment naming work. No prior finding was shown to have been wrong.

## Not verified

GitHub Actions CI status: the cloud proxy refused GitHub API access this session, so CI was judged only through Vercel deploy state. The traction weeks before 10-15 are lower bounds (usage_events retains 31 days).
