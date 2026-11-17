# Overnight pass — 2026-10-31 (genuine overnight; GREEN, 0 shipped)

**Run:** Cowork cloud, `rpc-nightly-overnight`. Fired ~08:03Z 2026-10-31 = **1:03 AM PT**. Push route: laptop-VM clone (`$HOME/rpcwork`) + `.rpc-git-cred` (dry-run up-to-date).

**Gate decisions.** Real time confirmed via DB `now()` 08:05Z + app-stamped rows (sales ingested 08:03Z, fmv computed 07:53Z) — **no clock skew** (shell/VM and DB agree). 1:05 AM PT is INSIDE ~00:00–06:00 → **genuine overnight, normal shipping allowed**. Lock was RELEASED (prior off-hours run 10-31 00:33Z); took it (`cowork-20261031T080319Z-3219`). No `FREEZE.md`. Push available.

**Verdict: GREEN. 0 shipped, 0 reverted. Nothing was safe/needed to ship — a quiet honest night.**

---

## Reviewed
- **Continuity:** CLAUDE.md (full), ledger head, focus.md (steers through 10-31), metrics-latest.json (10-30 baseline), the 10-30 overnight handoff, recent inbox.
- **Inbox:** drained through the newest filing `2026-10-29T0613Z` (Dapper notice). No new filings since on clone or mount. Inbox untouched (append-only). Dispositions below.
- **Health baseline:** `rpc_ops_snapshot()` (08:05Z).
- **Dashboards:** none flagged broken/stale by the monitor; none touched.

## Health-drift triage
- **Security:** clean — `invariants` [], `anon_write_holes` [], `rls_off_base_tables` [], `secdef_anon_violations` [].
- **Trust health:** 0 breaches, all 40 legs ok. `fmv_sanity_flags` 0. `panini_fmv_stale_hours` 0 (runner caught up vs 35.6 close-call last night). `candy_sales_stale_hours` 460.7 < breach_at 1114.9 (re-verify clock; re-verify candy_mlb ~11-27). `edition_integrity_flags` 22 (250). `trust_precompute_max_age` 5.29 ok.
- **Stalled pipelines:** [] — `panini-ingest-enum` is no longer listed (Trevor's laptop script resumed, or dropped out of window). Clean.
- **Sentinel:** `sentinel_ts_uuid_editions_48h` 0, `ts_uuid_dupes_created_24h` 0.
- **High-sev `pipeline_alerts` — the three Flowty `*-listing-cache` lanes (100% / 3 days):** POOLED pre-retirement history. **Retirement VERIFIED COMPLETE**: `golazos-listing-cache` last ran 17:46:14Z 10-30; `topshot-listing-cache` / `allday-listing-cache` have **0 runs since 17:46Z 10-30** (~14.3h). Alert self-clears ~11-02 as the 3-day window rolls past.
- **Medium `pipeline_alerts` — `topshot-active-listings-ingest` 2/7 failed (28.6%), last error `egress_blocked`:** low-volume lane, intermittent egress-proxy block. Not user-facing (the atlas market feed is the live book). WATCH; no safe code lever from the sandbox.
- **Info `pipeline_alerts`:** atlas editions/market/pack-supply 403s (3–4.4%, Cloudflare base rate; all below escalation, freshness fine — last successful drains 08:05Z, newest event 07:57Z); flow-rest moment-moved-400 (designed). `topshot-pack-supply-atlas` 236 fails/24h = the designed per-page 403 re-ask noise; `pack_ev` is fresh (max_stale 0.07d, publish_shortfall 0.49%).
- **Dapper marketplace-notice flap (inbox `2026-10-29T0613Z`) — RESOLVED.** `v_collection_marketplace_status` reads `nba_top_shot` = **healthy**, `buy_ctas_enabled` true; no stuck degraded notice on any live collection (ufc_strike `shutdown` is correct). The stale false "can't be bought" signal self-cleared (backstop + restore path).
- **Atlas/market freshness:** market-feed last drain 08:05Z / newest event 07:57Z; pack-supply last 200 08:05Z. Fresh.
- **Vercel:** prod serves `29d39b456` (origin HEAD at clone time) — not re-polled for a new deploy (no code shipped). 24h runtime errors = the same chronic groups (get_edition_detail 502 upstream, collection-snapshot RPC_READ_TIMEOUT since 09-11, insights/panini-premiums 8s since 10-14, market-cap tile nba_top_shot 8s). None new.
- **DB size 43,879 MB, +694 vs 00:25Z (43,185)** over ~7.7h (~2,160 MB/day pace if sustained, up from the ~630/day noted 10-30). **WATCH, not an alarm, and NOT bloat:** dead-tuple ratios on the churn tables are all <1.5% with current autovacuum (panini_card_serials 0.015 / wallet_moments_cache 0.014 / fmv_snapshots_2026 0.008 / topshot_atlas_market_events 0.012). The top tables barely moved (panini_card_serials 9,215→9,229, wallet_moments_cache 3,074→3,144, atlas_market_events 1,505→1,511), so the growth is spread (indexes/toast/WAL during the overnight FMV recompute + atlas firehose + sales ingest), which autovacuum reclaims. Re-check next pass; drill per-table deltas if the slope holds past the recompute window.

## Post-ship watch (10-29/10-30 Claude Code + Cowork wave) — GREEN
- **#215 / #216 / #217 / #218** — `fmv_sanity_flags` 0, 0 trust breaches, no new Vercel error group. No regression.
- **#217 reprice lane** — the 170-rip drift backlog was cleared by a 10-30 7:25 PM PT local one-off (stranded entry carried this pass; 6,507 candidates → 170 written, idempotent on rerun). The scheduled `rpc-reprice-drifted-high-value-rips` (`26 11 * * *`, confirmed active) first fires **11:26Z today = AFTER this pass**. **Expected next pass:** it writes ~0 (backlog already cleared), NOT ~170. A ~170 write again = the writer rule and the lane disagree (focus steer's regression shape).
- **seed-wallet-refresh 5:45 AM PT (~12:45Z)** — also fires after this pass; next pass checks `low_priority_skipped ≈ 0`.

## Shipped
None. No low-risk/reversible candidate presented: carried-queue items are Trevor-held (#58 secret) or Claude-Code-owned (panini_deal_board cache-warm watch) or external-console (Flowty cron-job.org cleanup); no new inbox; health green; DB growth is a WATCH with no safe lever.

## Stranded-output sweep
- **Carried ONE stranded ledger entry** into origin (commit `b062152ed`): a Claude Code **local** session (Trevor present, 7:25 PM PT 10-30) ran the drifted-rip re-price lane once via a one-off pg_cron job (170 rips re-priced: 88 TS $27,715 / 82 AD $14,289; 139 down, 31 up) and logged it to the laptop ledger only. It landed *after* the 10-30 overnight pass (5:19 PM PT) ran, so it was never pushed. Verified absent from origin (`6,507 candidates` grep = 0) before carry; spliced chronologically (7:25 PM, between the 8:41 PM FIXED-test and 5:37 PM Flowty-creds entries). Laptop copy left untouched (append-only mount rule). Both ledger integrity checks 0; heading count rose by exactly 2 (this carry + this pass's entry).
- **Nothing else stranded:** `flow-ecosystem-watch.md` and `metrics-latest.json` mount == origin; no mount-only inbox files; the only 10-30/10-31 handoff on the mount (`handoff-2026-10-30-overnight-pass.md`) is already in origin. The mount ledger is otherwise behind origin by 5 headings (Trevor pulls on his next work).

## Inbox dispositions (drained, not moved — append-only)
- `2026-10-29T0613Z` Dapper notice stuck degraded → **RESOLVED** (nba_top_shot healthy, CTAs on).
- `2026-10-27/28/29` Top Shot atlas/listing lanes dark → **RESOLVED** (atlas market-feed healthy, fresh drains 08:05Z; the Flowty listing-cache lanes were a separate concern and are now retired by design).
- `2026-10-26` candy-listings-indexer timeouts → **RESOLVED** (candy indexer 8/8 ok per marketplace note, 0 unresolved).
- Older filings: already dispositioned in prior handoffs.

## Queued (carried forward)
- **#58 OPENSEA_API_KEY** (P2, Trevor) — secret, no sandbox lever; candy_sales_stale is a re-verify clock (low pressure).
- **panini_deal_board / _all cache-warm statement-timeout** (watch, Claude Code) — ≤2/day, falls back to last good snapshot.
- **Flowty cron-job.org entries cosmetic cleanup** (non-urgent) — two rows already disabled 10-30; any remaining hit the 410 tombstone and log nothing. Trevor at leisure.
- **topshot-active-listings-ingest egress_blocked** (new, low) — intermittent egress-proxy block on a low-volume lane; monitor.

## Failed / blocked / reverted
None.

## Deltas vs 10-30
- db **+694 MB** (43,185 → 43,879) WATCH.
- FMV HIGH+MED: nba 6,541 → 6,573 (+32); panini 18,036 → 18,038 (+2); nfl 1,662 → 1,626 (−36); pinnacle 872 → 996 (+124); candy 73; golazos 1; ufc 0. All normal churn (no stale/sanity flags).
- editions: nba 14,609 / panini 40,136 / nfl 6,190 / golazos 575 / ufc 617 / candy 125 — flat.
- trust breaches 0 → 0.

## Commits
- `b062152ed` docs: commit stranded task output (ledger: #217 first-run reprice, 170 rips, 10-30 local).
- (this pass) docs(overnight): 2026-10-31 pass — GREEN, 0 shipped. Ledger entry + metrics + handoff + session.
