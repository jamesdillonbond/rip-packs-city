# RPC nightly autonomous pass — 2026-06-17 (GENUINE OVERNIGHT)

**Fired** 08:03Z / 01:03 PDT (in-window). **Push available.** Sandbox-native clone at `$HOME/rpcwork` (origin/main `a7e22ef` at start AND end — no human push mid-session; `/tmp` still squashes to uid nobody so the documented `/tmp/rpc` path stays unusable). Lock taken over (prior RELEASED ~24h old).

**Outcome: shipped 0 · reverted 0 · repaired 0 · closed 4.** A clean, honest night — no candidate was both warranted AND a fully-gated low-risk production change. The substantive value: closed the Serial-Premiums insights-QA (full pass), proved the TOPSHOT-LISTINGS-CURSOR false-positive is already handled, and verified the heavy 06-16 Trevor wave (especially the buyer-backfill maxDuration fix — the invisible-failure class) is healthy. 5th consecutive clean overnight on the Small tier.

---

## Post-ship regression watch — ALL PASS, 0 reverts

The 06-16 night pass shipped nothing, so every recent change is Trevor's daytime/evening work. Re-measured each one's target metric:

- **`95c07c5` buyer-backfill maxDuration 300→600 / batch 300→200 (BUYERBF-CRON-DROP supersede) — PASS, the key check.** This is the CLAUDE.md invisible-maxDuration-failure class (the 32de87a/900s incident flavor). Live: `topshot-buyer-backfill` 37 runs / **0 fails** / 12h, **max 503s** (above the old 300s ceiling that was silently killing it pre-log, comfortably under the new 600s and the 800s Pro hard cap), avg 381s, last 07:54Z. The route now runs to completion and logs cleanly; `detect_stalled`/`get_pipeline_alerts` both `[]`. **Root cause confirmed fixed, drain resumed.** WATCH note: 503s leaves ~97s headroom under the 600s ceiling — healthy now, but if the 2024 historical null-buyer backlog hits heavier wallets a run could re-approach 600 (same invisible-kill). Not an action; flag for tomorrow's watch.
- **`35e2c2d` tshb throughput dial (ELAPSED_BUDGET 120→180s, EDITIONS_PER_TICK 40→80) — PASS.** `topshot-sales-history-backfill` 4 runs/12h, 0 fails, **max 194s < 300s cap**. No hard-kill; the dial didn't push it over the ceiling.
- **`5f1a28d` AllDay on-chain unmapped resolver — PASS (draining).** open `unmapped_sales` **43** (night baseline 244 → 188 → 66 → 43). The ALLDAY-V1-UNMAPPED-DRIFT main class is resolving itself; `unmapped_resolution_backlog_max` trust leg 8/100 ok.
- **`f94704c` omni-channel alerts — now ACTIVATING (healthy).** Was inert at 18:17Z (0 channels). Now: **3 notification_channels**, alert_subscriptions 0, alert_deliveries 0; `alerts-dispatch` 3/0 + `alerts-send` 7/0 (last 08:04Z, 0 fails). Trevor wired the 2 alert crons + linked 3 channels during his evening session (consistent with the Discord/email thumbnail fixes 6222c0b/beaa36a). Dispatch/send crons run clean. Not a regression — operator activation in progress.
- **`abfb75a`/`116072b` Serial Premiums board — additive, healthy.** Backing views 271 (#1) / 10 (perfect), security_invoker=on. (Full QA below.)
- **`1e06cda` 30d price-band badge — additive column** on `get_wallet_moments_with_fmv`; no regression signal.
- **deal-board ingest (`5dad99b`/`489a04b`/`998b8a3`/`8cd2a43`/`b1a52d0`) — additive new surface.** `topshot_underpriced_serials_board` 37 rows; the home-machine Task Scheduler runner is the egress path (Atlas WAF blocks datacenter IPs). No production-route risk.
- **alerts thumbnail fixes (`6222c0b`/`beaa36a`) — inert** (format-only; only fire when alerts are delivered, which Trevor is now testing).

---

## Health-drift triage — GREEN

| Check | Value |
|---|---|
| `detect_stalled_pipelines()` | `[]` |
| `get_pipeline_alerts()` | `[]` |
| Security (4 checks) | **0/0/0/0** — RLS-off base tables 0; anon/auth write on RLS-off base tables 0 (with `relkind IN ('r','p')`); `check_public_security_invariants` []; `check_secdef_anon_execute_violations` [] |
| `v_rpc_trust_health` | **9/9 ok** (edition_integrity 4/50, fmv_sanity 0/1, offer_edition_gap 0/50, pack_ev_stale 0.80d/2, pack_ev_depleted 0/30, pinnacle_ask 0.2h/3, pinnacle_fmv 22.0h/30, ts_uuid_dupes_24h 0/200, unmapped_resolution_backlog 8/100) |
| Sentinel TS-UUID-keyed-48h | **0** |
| pipeline_runs | 24h **8819 / 3 fails**; 6h 3224/1; cohort wave 06:45–07:40Z **1992 / 1 fail (0.05%)** |
| Sentry | **2 unresolved**, both single-event smoke transients ~07:08Z (in the wave window); 0 genuine new |
| Vercel | prod **`a7e22ef` READY**; 20 recent all READY/CANCELED, **0 ERROR** |
| Artifacts | **19** (14 active + 5 RETIRED tombstones); none flagged broken; none repaired |
| Editions | TS 15543 / AllDay 6191 / Golazos 581 / UFC 446 (flat) |
| DB size | **4738 MB** (+57 vs 06-16 baseline, benign) |

**The 3 pipeline fails (24h) are all known transient classes:** `wmc-fmv-populate` @07:28Z (216s statement timeout, in the wave window — recovered immediately, avg 4.5s on the next ticks, 1/717); `analytics-smoke` @16:43Z (the known DB-IO barometer); `offers-sweep` @12:22Z ("fetch failed"). The cohort wave 1992/1 confirms pacing is holding on the Small tier.

**Sentry:** both unresolved issues (`JAVASCRIPT-NEXTJS-1E` "sales indexers running (detect_stalled)" + `JAVASCRIPT-NEXTJS-A` "fmv pipeline healthy") are single-event smoke-test transients fired ~07:08Z — squarely inside the 06:45–07:35Z wave window (brief DB-IO contention trips a smoke check). `detect_stalled` is now `[]` and FMV is independently verified healthy. Left unresolved (<24h quiet; resolving smoke transients early just re-opens them).

### FMV HIGH+MED dip — benign reclassification, NOT ship-attributable (WATCH)

TS HIGH+MED (latest-per-edition, `fmv_current` = the canonical `DISTINCT ON (edition_id) ORDER BY computed_at DESC` view) read **2848** (HIGH 769 / MED 2079) — down from the 06-16 08:05Z baseline of 3426 and below the week's overnight range (3282–3426). Investigated before treating as drift:

- The dominant 24h move is **LOW/MED → ASK_ONLY** (ASK_ONLY 930 → 2600; LOW 6803 → 5874; NO_DATA 3818 → 3697 stable). This is the documented daily reclassification by the canonical writer: editions whose recent sales aged out of the 30d confidence window but that carry a live ask are honestly relabeled ASK_ONLY.
- **All ASK_ONLY/HIGH/MED rows are written by the canonical writers** — HIGH/MED entirely `1.7.0` (fmv-recalc, fresh 08:08Z); ASK_ONLY `1.7.0` 2323 + `cold-tail-1.0` 232 + `topshot-gql-v1_haircut` 23 + `thin-sales-guard-v3` 21. **No rogue/new writer.**
- **Writers fresh + clean:** TS FMV snapshot 08:09Z; fmv-recalc 85 runs/0 fails/24h; TS sales flowing (15,244/24h, latest 08:03Z) — no writer stall, no sales drought. `fmv_sanity_flags` 0 (no impossible FMVs).
- **No recent ship touches FMV writer logic** (all additive insights/alerts/deal-board/buyer-backfill). → NOT ship-attributable, NOT an auto-revert situation, and FMV route logic is off-limits anyway.

**Verdict:** benign confidence reclassification (30d sales window rolling + improving ask coverage moving thin/aging editions to the more-honest ASK_ONLY). Queued as **FMV-HIGHMED-DIP-WATCH** (informational) for the daytime monitor to confirm the daily-cycle recovery and that ASK_ONLY isn't over-claiming editions that have usable sales.

---

## Closed this run (4)

1. **SERIAL-PREMIUMS-INSIGHTS-QA — ✅ CLOSED (full pass, no gap).** Ran the full rpc-insights-qa 8-point checklist against `/insights/serial-premiums` (`abfb75a`, prod READY). All pass: (1) **security** — both backing views `topshot_serial_premiums_board` (271 rows) + `topshot_perfect_mint_premiums_board` (10) are `security_invoker=on` + anon-SELECT; `check_public_security_invariants()` [] + `check_secdef_anon_execute_violations()` [] (no base-table hole); (2) **route** — `/api/public/insights/serial-premiums` under the proxy allowlist, tier→400-on-invalid, window 7d/30d/90d, sort premium/headline_price/recent (no1_price alias), limit clamped 1..100, min_premium default 5; (3) **sitemap** `app/sitemap.ts:330` 'serial-premiums'; (4) **canonical** param-stripped `/insights/serial-premiums` in layout.tsx; (5) **drill-downs** server-rendered ranked rows + `/nba-top-shot/edition/<external_id>` (encoded) links crawlable; (6) **freshness** views read sales live + 15-min ISR/s-maxage; (7) **brand** 49 `--rpc-*` + 28 `--font-*` tokens, **0** hardcoded `#E03A2F` (the OG route's `#E03A2F` is the documented universal Satori exception every insights OG route shares); (8) **OG + JSON-LD** — OG route **does exist** at `app/api/og/insights/serial-premiums/route.tsx` (1200×630, data-rich top-3 + generic fallback; the 18:17Z monitor searched `app/api/og/serial*` and missed the nested `insights/` path), WebApplication JSON-LD (matches the top-sales/trophies siblings — the documented WebApplication-only non-gap nit). Empty-state honest ("No qualifying {#1|perfect} mint sales in this window."). proxy.ts:302 `/insights/*` public; robots allows `/insights`. Live HTTP-200 deferred (web_fetch provenance) — deploy READY + anon-public views + 0 Sentry = high confidence, same basis as the 06-14 TROPHIES + 06-15 TOP-SALES closes.

2. **TOPSHOT-LISTINGS-CURSOR-FALSEPOS — ✅ CLOSED (already handled, no action).** Investigated the `get_pipeline_alerts()` cursor_stalled false-positive on the retired TS listings-indexer (`event_cursor` id `topshot_listings`, frozen at block 152767514 / 2026-05-26 = the documented retirement). **The orphaned cursor is ALREADY in `pipeline_alert_suppression` with `expires_at = NULL` (permanent)** — exactly the established mechanism (the 3 pack-backfill cursors are suppressed to 2031). The function's `active_suppressions` CTE (`WHERE expires_at IS NULL OR expires_at > NOW()`) therefore permanently excludes it from cursor_stalled, which is why `get_pipeline_alerts()` returns `[]`. The 21:08Z monitor saw it fire because the suppression was added afterward (during Trevor's evening session); the 03:06Z monitor saw `[]` but attributed it to "banded" without checking the suppression table. Nothing to ship — the false-positive is permanently suppressed. (Inert leftovers: `golazos_listings`/`ufc_listings`/`ingest-external-announcements` suppressions expired but their cursors aren't in the >6h stale list, so no false-positive surfaces — harmless, left alone.)

3. **ALLDAY-RESOLVER-ZERO-WRITE-TRIPWIRE — ✅ CLOSED (addressed by the 9th trust leg).** The 8am 06-16 candidate (the AllDay consumer-GQL WAF block silently undercounting V1 sales ~16% while the resolver logged `ok=true`) was addressed same-morning by `audit_20260616_trust_health_unmapped_resolution_backlog_leg` — the 9th `v_rpc_trust_health` leg `unmapped_resolution_backlog_max` (verified live, **8 / breach 100 / ok**, catches "a collection's priced sales failing edition-resolution → sales undercount"). Covers the recurrence class. Documented residual (not a gap): it is a backlog-SIZE tripwire (breach >100), not a literal "resolved-count/24h = 0" throughput check — it won't catch a resolver holding the backlog flat <100 while never draining the tail. A throughput companion is the only residual; closed as-is (the size tripwire is sufficient — a resolver holding <100 isn't materially undercounting).

4. **BUYERBF-CRON-DROP — ✅ CLOSED (superseded by `95c07c5`, verified PASS).** See post-ship watch: max 503s < 600s ceiling, 0 fails, logging cleanly, drain resumed, `get_pipeline_alerts` clear. **Do NOT re-queue, do NOT widen the watchlist threshold** — the fix addresses the root cause (route killed at the old 300s ceiling before the finally block logged), not a cron-job.org drop.

---

## Queued (NEW this run)

- **UFC-EDITIONS-SEED-GAP · NEW · [LOW · CC/operator — seed/ingest, off-limits].** From the 16:33Z weekly DQ-sweep: 72 distinct UFC editions (166 wmc rows) are held by wallets but **absent from the `editions` catalog**, surfaced 06-13→06-16 by the new `ufc-enrichment-drain` cron resolving `wmc.edition_key` faster than the UFC editions seed (e.g. `BRUNNO-FERREIRA-UFC-283-KO-TKO-2500` returns nothing from `editions`). Real fighters/events/circulations (~14% of the 446 UFC editions wallets hold are unseeded), breaks the wmc-contract invariant for UFC, thin metadata on those moments. **No FMV/pricing corruption** (UFC FMV is overwhelmingly NO_DATA). Fix (off-limits to the night pass — seed/ingest logic): seed the 72 missing UFC editions, or give `ufc-enrichment-drain` a companion edition-seed for keys it resolves that aren't in the catalog. Orphan list reproducible: `SELECT DISTINCT edition_key FROM wallet_moments_cache w WHERE collection_id='9b4824a8-736d-4a96-b450-8dcc0c46b023' AND edition_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM editions e WHERE e.external_id=w.edition_key AND e.collection_id=w.collection_id);`
- **OFFER-SANITY-VIEW-REFINEMENT · NEW · [LOW · optional · CC].** `v_offer_sanity_flags` is now 100% sub-serial (201 flags, all `has_sub_serial=true`) — the edition-grain class was closed 06-14 and sub/serial offers are intentionally never raised, so the view only ever climbs with benign sub-serial accrual and no longer functions as an anomaly detector. Optional: add `WHERE NOT has_sub_serial` (or split sub-serial into its own informational view) so the flag count is a true edition-grain anomaly signal again. NOT shipped: the edition-grain signal is ALREADY covered by the `offer_edition_gap_max_usd` trust leg (0/50 ok), so this is low-value; and modifying the existing view's semantics (vs a new additive view) is a CC call, not worth the night-pass risk.
- **TS-WMC-UUID-FOSSILS · NEW (known/stable) · [LOW · CC — canonical-merge, off-limits].** 1,683 wmc rows still keyed to merged/deleted UUID-pair TS editions (span back to 2026-05-06) — stable residue of the retired `wmc_edition_key` drain era; self-heals only via a canonical-merge re-key (the DUPE1 class, CC-owned with its own gate). Not growing alarmingly; flagged for completeness.
- **FMV-HIGHMED-DIP-WATCH · NEW (informational) · [LOW · daytime monitor].** TS HIGH+MED 3426 → 2848 over 24h via benign canonical-writer (`1.7.0`) reclassification of thin/aging editions to ASK_ONLY (930 → 2600). Writers fresh, fmv-recalc 85/0, sales 15,244/24h, `fmv_sanity_flags` 0, not ship-attributable. Daytime monitor: confirm the daily-cycle recovery (the daytime peak was 3435 at 18:17Z) and that ASK_ONLY isn't over-claiming editions with usable sales. No action unless HIGH+MED keeps falling below the week's range without a daytime recovery.

## Carried (unchanged)

- **SERIAL-FMV-MULT-CRON · [LOW · Trevor/operator].** `refresh-serial-fmv-multipliers` (shipped `0122f9c`) still has **0 pipeline_runs ever**; `serial_fmv_multipliers` (37 cells) last computed 2026-06-15 23:06Z = now **~33h stale**. Decide cron-vs-manual (mid-build dial-in). Impact LOW (estimates labelled + floored at edition FMV).
- **ALLDAY-V1-UNMAPPED-DRIFT · [LOW · operator/CC].** Main class draining well (open 43 via `5f1a28d`). Narrow to the residual: the ~34 `v1_tx_decode_budget_exhausted` fossils (oldest 05-21; `/api/admin/recover-v1-budget-exhausted` exists, still 0 cron) + the 1 AllDay-v2 + 1 Golazos-v2 fossils. Decide: wire recover-v1 low-cadence, or classify as permanent residual.
- Standing: N1 (snapshot-institutional-wallets cron drop, operator), VERCEL cost family (Trevor dashboard — $66 Fluid / $24 Observability / spend-pause backstop / cohort-thin), A1-WORKER-PASSTHROUGH-CLEANUP (Trevor/wrangler), get_user_top_owned_moments 3-arg orphan (Trevor/CC, destructive cleanup), PIN-FMV-REKEY-WAVES 2/3, PIN-SYNC-CRON, PACKVIZ-GRID, P3-BUYERS, DUPE1, Q2/Q5/Q6, ANALYTICS-SMOKE-RESIDUAL (optional dashboard-fn work), IPFS x2 — see ledger.

## Failed / blocked / reverted
None. No production shipping attempted (nothing both warranted and fully-gated low-risk); no hard-stop triggered.
