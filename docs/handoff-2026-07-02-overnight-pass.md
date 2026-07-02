# RPC nightly autonomous pass — handoff 2026-07-02

**Mode:** GENUINE OVERNIGHT (fired in-window 08:03Z / ~01:02 PDT). **No clock skew** — shell `date` 08:02Z ≈ DB `now()` 08:02:35Z ≈ app-stamped `max(sales.ingested_at)` 07:56Z / `max(fmv.computed_at)` 07:58Z (production rows can't be future-stamped, so they bound real time from below). Push available (`git push --dry-run` = up-to-date). No FREEZE. Lock was RELEASED + ~31h stale → took over cleanly.

**Result:** Shipped **0** production changes (correct — the heavy 07-01 evening CC "do everything" wave already drained the actionable work; every remaining candidate is off-limits route logic, a benign single-crawler one-off, not-a-hole/already-dispositioned, or CC/operator/gated). Reverted **0**. Repaired **0** artifacts. Closed **0**. Drained **3** inbox files. The value tonight is the independent post-ship watch (ALL PASS) + health-GREEN verification + correct dispositioning of the flapping classify-acq item.

Sandbox clone `$HOME/rpcwork`; origin/main `5206c357` unchanged start→end.

---

## Reviewed

- **Inbox (3 files, all 07-01 monitor ticks):** `2026-07-01T151603Z.md` (first-of-day, GREEN + 2 candidates), `2026-07-02T001400Z.md` (17:14 PDT, GREEN + OG-BACKSLASH), `2026-07-02T060800Z.md` (23:08 PDT last-of-day, GREEN + classify-acq re-flap correction). All three ticks reported Health GREEN. Archived to `inbox/archive/`.
- **Post-ship watch** of the heavy 07-01 evening CC wave (~19:38→23:35 PDT, origin/main `811ac094`→`5206c357`): P1a/P1 FMV display guard (market+sniper de-fake), P2 AllDay cross-source dedup writer trigger, P3 UFC ipfs-media proxy (+JSON-LD residual), P6 analytics buyback name resolution, F1 sales-indexer ::subID→base redirect, F4 reward-pack KPI suppression, Item 2 AllDay pack-EV v8, Item 5 Pinnacle render enrich, Item 7 pinnacle/overview trim, plus the mis-attribution parallel writer-leak self-healer.
- **Artifacts:** 15 in manifest, none flagged broken by tonight's 3 monitor ticks (which validated rpc-live-health end-to-end). Data is fresh-on-open; none regenerated (WEEKLY-SURFACE-QA-PROSE cosmetic footer carried, not worth a full-file reinstall for an unattended pass).

## Post-ship watch — ALL PASS, 0 reverts

- **editions FLAT** (TS 17,489 / AllDay 6,191 / Golazos 581 / UFC 518, identical to the 07-01 overnight baseline) — no writer leak from the AllDay dedup trigger, the F1 sales-indexer ::subID→base redirect, or the mis-attribution self-healer.
- **sentinel TS-UUID-48h = 0** (down from 17 last night) — mis-attribution + F1 redirect are not leaking UUID-keyed editions.
- **fmv_sanity_flags = 0** — the FMV display guard (read-side clamp, `fmv_snapshots` untouched) + Pinnacle render enrich did not corrupt FMV.
- **security 0/0/0/0** — the P2 dedup trigger (`trg_zzz_allday_cross_source_dedup`, SECDEF, anon/auth REVOKEd, present + enabled on all `sales_YYYY` partitions), the display-guard table/fn, and the mis-attrib self-healer opened no anon/RLS holes.
- **P2 dedup trigger is NOT blocking legit inserts:** AllDay sales flowing across all 4 sources in the last 6h (`allday_studio_history_v1` 4,583, `onchain` 305, `onchain_dapper_v1` 89, `onchain_dapper_v2` 87, latest 07:56Z fresh).
- **P1a backing data healthy:** `topshot_fmv_display_guard` 1,381 rows (451 `fmv_exceeds_max` — matches the commit's "450+ TS editions", + 1,154 thin), fresh (computed 05:28Z), cron `rpc-refresh-fmv-display-guard` (45 13 * * *) active. AllDay low-ask cron `rpc-allday-badge-low-ask-refresh` (*/30) active.
- **Vercel:** current prod = `dpl_HhC91cAMBckN2gDQq9fAcR9gz1n1` (e8396707, P3 JSON-LD residual) READY. No ERROR-state deploys in the last 20 (all CANCELED entries are docs/monitor commits via ignoreCommand). Runtime errors (12h) = all known families; NO new class attributable to any 07-01 commit.

## Health-drift triage + deltas (vs 2026-07-01 08:05Z baseline)

Health GREEN. `rpc_ops_snapshot()`: security **0/0/0/0**; trust **15/15 ok** (breaches []); `stalled_pipelines` **[]**; `pipeline_alerts` 1 INFO (ufc_sales resolving_editions, benign); `check_pgcron_recent_failures()` **[]**.

| metric | last night | tonight | note |
|---|---|---|---|
| FMV TS HIGH+MED | 4,679 | **4,710** (1322+3388) | improving |
| FMV AllDay HIGH+MED | 911 | 882 (239+643) | benign re-bucket (ASK_ONLY 1309 / STALE 524 as studio backfill adds sales); editions FLAT, fmv_sanity 0 |
| FMV UFC / Golazos H+M | 15 / 5 | 15 / 5 | flat |
| editions TS/AllDay/Gz/UFC | 17,489/6,191/581/518 | 17,489/6,191/581/518 | FLAT (no leak) |
| sentinel TS-UUID-48h | 17 | **0** | improved |
| unmapped_resolution_backlog_max | 29 | 29 | flat, OK (100 breach) |
| DB size | 6,992 MB | 7,212 MB | +220; expected (8 new sales-partition indexes ~80MB + AllDay studio backfill still filling per focus.md) |

- **pipeline_runs 24h fails:** 16 pipelines. Verified 11/12 sampled have latest-run ok=true within ~1h (transient connection-pool contention during the backfill wave). Two live-status notes below.
- **`classify-acquisitions-multicollection` — flapping, QUEUED (see below).** Latest 07:06 ok 40.7s; 06:06 FAIL 94.9s; the AllDay leg oscillates near the 90s fn timeout (03:06 89.3s, 05:06 88.5s). Confirms the 06:08Z monitor correction exactly.
- **`apply-fmv-haircut` — one-off transient, NOT a candidate.** Latest run 06:31 FAILED at 125.4s "upstream request timeout" (Supabase API-gateway ~120s cap on the synchronous RPC). But it ran ~2s on **every** prior day (07-01 2.5s, 06-30 2.3s, …). Today's fail sits inside the 06:28–06:31Z micro-cluster of pool/gateway contention (SMOKE-TEST 06:31:28, pack-sniper 06:31:44, wallet-backfill 06:28–06:31 all timed out in the same 3-min window). Daily cron, next tick 07-03 06:30Z; not touched by the 07-01 wave; not a stall; a single missed daily haircut re-applies next day (immaterial). Watch: if 07-03 fails too, escalate.

## Queued — needs Trevor / CC (nothing auto-shippable tonight)

### NEW / re-sharpened

- **CLASSIFY-ACQ-ALLDAY-STATEMENT-TIMEOUT (LOW-MED; night-count 2; CC route / operator — do NOT close).** The `nfl_all_day` leg of `classify-acquisitions-multicollection` (hourly :06) flaps at the SECDEF fn's own 90s `statement_timeout`. The 07-01 `795d99b` "AllDay batch 300→80" cap bought ~half a day of headroom but the leg duration is CLIMBING BACK to the 90s cliff (01:06 50s → 02:06 78s → 03:06 89s → 05:06 89s → 06:06 **FAIL 95s** → 07:06 40s) because the candidate CTE Merge-Anti-Join scans the FULL AllDay sales history, which is still GROWING as `allday_studio_history_v1` fills (~1–4 day drain, started ~06-30). **Impact LOW** (moment_acquisitions cost-basis enrichment; NOT FMV / deal-boards / pack-EV / user-facing); flaps-not-stalls. **Not auto-shipped:** route runs in `after()` under `maxDuration=120` with the fn at 90s — a naive fn-timeout bump risks the invisible after()-lambda-kill class (the documented 06-20 special-serial-MV anti-pattern). The 07-01 overnight pass already measured that there is **no clean index fix** (already on the ideal index) and a `sales(collection_id,nft_id)` composite would tax the hot ingest path. **Durable levers (CC):** (a) let it settle once the AllDay studio backfill finishes filling (history stops growing → cost stabilizes; re-measure then), or (b) bound the candidate CTE to a recent window. Another naive batch reduction only re-erodes. Do NOT close while flapping.

### Carried / dispositioned (from the inbox, no action)

- **OG-BACKSLASH-500 (LOW; trending-close).** Malformed `%5C`-suffixed OG routes (`/api/og/insights%5C`, `/api/og/insights/pack-reality%5C`, `/pack-sniper%5C`, `/fast-break%5C`) throw MODULE_NOT_FOUND (500) instead of 404. A single crawler burst first=last **2026-07-01T23:03:5x** on the now-superseded `dpl_HLe4c`; **no recurrence in ~9h**. Benign (500 to one bot on a non-existent OG path; no user/data impact). Per the monitor's own guidance "if it stays a one-off 23:03 burst, close as crawler noise." Not worth an autonomous code deploy; ready fix if it recurs = normalize/strip trailing `%5C` (or `notFound()` guard) before the OG route resolves.
- **DORMANT-ANON-DML-REVOKE-REGRESSED (LOW; NOT a live hole; attended-session dispositioned = accept RLS-on).** Re-measured tonight: **154** base tables carry the Supabase-default anon INSERT/UPDATE/DELETE/TRUNCATE grant, but **0 with RLS off** → `anon_write_holes` [] and `rls_off_base_tables` []; every one is RLS-on with no permissive public write policy, so writes are default-denied and unreachable. The 06-23 scoped revoke provably re-accumulates (Supabase platform re-applies schema-wide default GRANTs), so a one-time re-revoke is low-value without a durable guard, AND a scoped revoke touches hot tables (`editions`/`wmc`/`sales`) under the destructive-op circuit-breaker — never a blind unattended sweep. The 07-01 attended session already chose "accept the RLS-on posture." No action; documented so future passes don't re-chase.
- **TEAM-PAGE-STATEMENT-TIMEOUT (LOW; dispositioned).** `/[collection]/team/[slug]` detail+activity trip statement_timeout (2 events each, low-volume, long-standing since 06-04/06-08). Attended session: pool-collateral, ~1.75s cold, already 8s-guarded → degrades to empty, not a page 500. Same DBSAT class as the other entity-page timeouts; a per-entity LATERAL/Suspense refactor is a CC perf change. Carried.

### Long-standing carried (unchanged, night-count noted where relevant)

- **SERIAL-FMV-POWER-MODEL-WEEKLY-TIMEOUT** (night-count 3; resurfaces **07-05** Sun; FMV-adjacent + unverifiable-in-run since the weekly pg_cron won't fire tonight to confirm; ready fix `ALTER FUNCTION public.compute_serial_fmv_power_model(uuid,integer,integer,numeric) SET statement_timeout TO '600s'` + same on `compute_serial_fmv_multipliers`).
- SMOKE-SECURITY-GUARD-TRANSIENT-API-PROBE-DEBUG (folds into ANALYTICS-SMOKE-RESIDUAL); REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT; BUYERBF-PERINVOCATION-WORK; ALLDAY-V1-UNMAPPED-DRIFT (owned); WEEKLY-SURFACE-QA-PROSE; THIN-FMV-GUARD-CONTENTION; refresh-conflated-editions cron (operator); topshot-sales-history-backfill watchlist; VERCEL cost family (on-demand cap ~early July); A1-WORKER-PASSTHROUGH-CLEANUP; PIN-FMV-REKEY-WAVES 2/3; PIN-SYNC-CRON; P3-BUYERS; DUPE1 (gated/CC); Q2/Q5/Q6; N1; IPFS ×2. See ledger.

## Failed / blocked / auto-reverted

None. No production shipping attempted (shipped 0), so no verification failure and no hard-stop.

## STEER honored

SERIAL-FMV weekly by design; evm-429 benign; studio-backfill volume expected (do NOT flag `allday_studio_history_v1` growth or the DB +220 as anomaly); Declined items not re-raised.
