# RPC overnight pass — 2026-11-25 (~1:05 AM PT)

**Session:** Cowork cloud, linked to Trevor's laptop. Git via laptop-VM `blob:none` clone + `.rpc-git-cred` push (no `add_repo` tool this session). Run id `rpc-nightly a885f7d4`.

**Verdict: GREEN, docs-only night (0 shipped, 0 reverted).** Every candidate this pass was already-fixed, self-cleared, or off-limits route-logic. A quiet honest night.

---

## Gates
- **Clock:** no skew. shell 09:02Z / device 09:02Z / DB `now()` 09:05:51Z / newest sale 09:03:09Z / newest FMV 08:53:43Z — all within 3 min. Real local time ~1:05 AM PT → **genuine overnight**, normal shipping allowed.
- **Lock:** was `RELEASED` (prior `rpc-context-hygiene` 1598ff07-c, pushed 04b059bee — confirmed an ancestor of origin/main). Taken over as `rpc-nightly a885f7d4`; released at end.
- **FREEZE:** none.
- **Push:** AVAILABLE (`--dry-run` exit 0, "Everything up-to-date").
- **Collision gate:** origin/main = `3f768c942` at start; re-checked before writing, no advance.
- **Stranded-output sweep:** CLEAN. All laptop `docs/overnight/` continuity files (ledger, metrics-latest.json, flow-ecosystem-watch.md, inbox/INDEX.md) hash-match origin; no mount-only inbox / handoff / health files.

## Reviewed
- CLAUDE.md (full), ledger (full + Declined), 3 new inbox items, `docs/overnight/focus.md`, metrics-latest.json (11-24), latest handoffs + the 11-24 evening session log, known-issues pointers.
- Health: `rpc_ops_snapshot()` baseline + independent security catalog SQL + GHA backfill freshness + post-ship watch.

## Inbox dispositions (3 new since the 11-24 ~1:14 AM pass; inbox left untouched — append-only)
1. **`2026-11-24T1617Z` — misattrib-remap daily timeout → RESOLVED (verify).** The 11-24 evening pass already fixed it: `rpc-topshot-misattrib-remap` moved to `cron_heavy` (600 s budget) as job 926 (`20261125025303`). Tonight's 05:53Z run **succeeded, 102.5 s, 1 row** (job 926's only run so far; the 600 s budget is in place but still not exercised past 120 s — a later >120 s success will prove it). No action.
2. **`2026-11-25T0415Z` — pg_net_http_403 publicnode indexed-token CRITICAL → SELF-CLEARED; masking-prevention QUEUED.** Not in the 09:05Z `pipeline_alerts` at all — the 4 benign `-32602 "Indexed requests require a personal token"` 403s to solana-rpc.publicnode.com aged out of the arm's 2 h window. Candy health green (`candy_sales_stale` 1.3 h, `candy_ask_book_drop_pct` 4.3, `candy_offers_unverified_pct` 0, all ok). The arm only read CRITICAL because the 403s were unattributed to a `request_id`. QUEUED (low) for the owner — see below.
3. **`2026-11-25T0712Z` — refresh_wmc_fmv_changed deadlock/lock-timeout pair → SELF-CLEARED; fix QUEUED (off-limits route-logic).** The two ticks (04:13Z 40P01 deadlock, 04:18Z lock timeout) rolled back; the next 16 runs are all ok, no errors. The real fix (extend the 2026-11-10 `FOR UPDATE ... SKIP LOCKED` treatment to this writer) is a `CREATE OR REPLACE` of a pinned function on the FMV family = off-limits for an autonomous pass. QUEUED with the inbox's ready diagnosis. 3 fails/24h, no trust-health breach.

## Health-drift findings + deltas
- **Security:** clean on all 4 snapshot arms AND independently via direct catalog SQL — `rls_off_base_tables` 0, anon/authenticated write-grant-on-RLS-off 0. All drift arms [] (search_path / txn-control / cursor-rewind / suppression-parked / suppression-count / cross-collection-mat).
- **Trust:** 43/43 ok, 0 breaches, no UNKNOWN.
- **Pipelines:** `stalled_pipelines` []. 1 medium alert: `gha-schedule-watchdog` (30/109 failed over 3 d; known self-clearing #80 GHA schedule-delivery class, inbox `2026-11-23T1913Z`). Its own body reports **0 cadence lanes breaching**, and the GHA-scheduled backfills are fresh (`topshot-sales-history-backfill` 1.2 h, `pinnacle-owner-discovery` 6.9 h, `ownership-sync-dune` 21.4 h, all ok) so the "two GHA backfills silent >24 h" escalation trigger is **not met**. 8 info alerts, all Atlas/Dapper Cloudflare-403 base-rate + flow-rest moved-moment 400 (all designed).
- **Pipeline fails 24h:** all low (gha-schedule-watchdog 11, atlas-pack-market 9, panini-collector-walk 5, candy-chain-sales 3, refresh_wmc_fmv_changed 3, rest ≤2).
- **Sentinel:** `sentinel_ts_uuid_editions_48h` 0, `ts_uuid_dupes_created_24h` 0.
- **Vercel runtime (24h):** 24 groups. 20 are the chronic honest read-timeout degradations (pack-detail family, player/team entity-section, insights boards, sniper-feed; count 1-5, on older deploys). 2 are the pre-existing wallet pack-history 20 s RPC timeouts. **The one distinct error: `pinnacle-image /_next/image` MODULE_NOT_FOUND** — `Error: Cannot find module './.next/server/pages/_next/image.js'` on `/api/public/pinnacle-image/[renderId]`, first seen 2026-10-19, ~4 occurrences / 1-2 users in 24h (latest 08:01Z). Pre-existing, not an evening-wave regression; low severity (broken image fallback, no fabricated data). Noted as a low QUEUE observation — it is public route logic, so not autonomous-shippable.
- **Deltas vs 11-24:** db 57,694 → 58,778 MB (+1,084, routine). Trust breaches 0 → 0. FMV HIGH+MED: nba 7,072→7,214, panini 24,162→24,428, nfl 1,748→1,839, pinnacle 931→913, candy 41→65, golazos 1, ufc 0. editions panini +638, candy +1, nba flat.

## Post-ship watch (large 11-24 evening Claude Code feature wave) — CLEAN, 0 reverts
The 11-24 evening wave shipped trade-room seal/cancel/verify hardening, All Day official series names + home/away repair, binder table width fixes, pack-history v34/v35 cost/value-gap fills, and the Pinnacle capsule-chaser pack page. All were attended Claude Code ships with planted-defect tests + preflight green.
- **CI green** on HEAD `3f768c942` (13 success / 16 skipped — docs-only) and on the last code tip `8aeece563` (26 success / 3 skipped). The main CI red from `4754a0110` (All Day names) was already re-pinned green by the evening pass (`65c7f3f55`, `4b711f4f5`).
- **Prod** = `dpl_DrfF2VuGJQ8bjDWmqCd428ijihzM` = `8aeece563` READY (rollback candidate). The two docs-only tips (`33f5a862d`, `3f768c942`) CANCELED via `ignoreCommand` (expected — a docs-only push never rebuilds).
- No new runtime-error cluster attributable to the wave. No regression → no auto-revert.

## SHIPPED
None. 0 production-affecting changes; ship budget untouched.

## QUEUED (for Trevor / owner)
1. **refresh_wmc_fmv_changed SKIP-LOCKED extension (low, nc1).** Extend the 2026-11-10 treatment (`audit_20261110_stuck_wmc_fmv_resync_skips_rows_another_writer_holds`) to `refresh_wmc_fmv_changed`: take its target `wallet_moments_cache` rows `FOR UPDATE ... SKIP LOCKED` in a materialized CTE ordered by a unique key, then UPDATE by id (byte-identical output, no deadlock). Pinned-function discipline (re-derive live md5 before the write; grants unchanged). Off-limits autonomous = FMV-family route-logic. Damage per event is one rolled-back ~5-min tick; self-clears. Ready diagnosis: inbox `2026-11-25T0712Z`. Optional first step: read the Postgres log at 04:13Z to confirm the deadlock partner (likely `reconcile_saved_wallets_wmc_fmv` or `resync_stuck_wmc_fmv`). Acceptable to leave as-is if it stays ~3/24h and never breaches trust health.
2. **pg_net_http_403 publicnode indexed-token masking (low, nc1).** The benign-but-recurring 4xx CRITICAL will mask a genuinely-critical `pg_net_http_403` later. The arm's own stated fix: have the candy lane that dispatches the indexed publicnode call **record its dispatch `request_id`** so the arm attributes and clears; or route indexed Solana methods (`getSignaturesForAddress` / asset-indexed reads) to a keyed/archive RPC; or add a narrow suppression. All three touch candy pipeline / alert semantics → not autonomous. Candy data is unaffected (keyless-RPC fallthrough). Ready analysis: inbox `2026-11-25T0415Z`.
3. ✅ **DISPOSITIONED 11-25 ~7:05 AM PT (Claude Code cloud, attended; Trevor: "Keep going"): no fix, contained by design.** The logged request is the OG builder's `/_next/image?url=/api/public/pinnacle-image/<id>` (`lib/og/img-data.ts` `ogOptimizedTarget`; there is no `next/image` caller of the route). That builder already falls back to `pinnacle_render_cache` and then a direct fetch when the optimizer refuses, so the only cost is an error line. The logged render (OEEV2-SWHL-C3PO-E4) now resolves: the route returns 302 and the optimizer returns 200 image/png. An unresolvable id returns a clean 404 with no lambda error, so the trigger is not reproducible on demand. Re-open only if OG cards for Pinnacle start rendering without art. Original observation: **pinnacle-image `/_next/image` MODULE_NOT_FOUND (low, observation).** `/api/public/pinnacle-image/[renderId]` intermittently fails requiring `./.next/server/pages/_next/image.js` (pages-router image module missing in the app-router lambda bundle). Pre-existing since 2026-10-19, ~4 occ/24h, 1-2 users; effect is a broken image fallback on some Pinnacle renders. Public route logic → needs an attended look (likely the route delegating to Next's image optimizer in a way that doesn't resolve in the serverless bundle). Not re-filed to inbox; tracked here.

## FAILED / BLOCKED / REVERTED
None.

## Continuity
- Ledger: one entry prepended (this pass).
- metrics-latest.json: overwritten with tonight's values.
- inbox/: untouched (append-only; dispositions above).
- Lock: released.
