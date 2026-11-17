# Overnight autonomous pass — 2026-06-20 (GENUINE OVERNIGHT, 01:02 PDT)

**Mode:** genuine overnight (fired 08:02Z / 01:02 PDT, in-window). **Push available.** Sandbox-native clone (`$HOME/rpc`, NOT `/tmp` — `/tmp` squashes new files to uid `nobody`). origin/main `8760bda` at start and end (no human/CC pushed mid-run).

**Outcome:** shipped **1** (a watchlist row, fresh-subagent-verified PASS) · reverted **0** · repaired **0** · closed **1** · NEW/updated queued **1**. Post-ship regression watch over the dense 06-19→06-20 Trevor/CC wave = **ALL PASS, 0 reverts**. Health **GREEN**.

---

## 1. Post-ship regression watch (last ~24–48h ships) — ALL PASS, 0 reverts

Re-measured every change shipped since the last night pass and the metric each was meant to move.

- **`8ffb291`/`06ad6e8`/`78ca042`/`c3a13a1` — OffersV2 fill -> sales (new `source=offer_fill` TS sale path) — PASS.** `sales` where `source='offer_fill'` = **4,469 rows / 4,469 distinct `transaction_hash`** (zero internal dup), +235 since the late-tick monitor (4,234) = the GHA `?sync=1` backfill still draining cleanly; 26 offer-fill pipeline runs / 0 fails in 24h. FMV reconciles **EXACTLY** (TS 15,543 latest-per-edition = 15,543 editions / AllDay 6,191 = 6,191), `v_fmv_sanity_flags` **0**, `ts_uuid_dupes_created_24h` **0**. The new sale path did not corrupt FMV or create dup-tx rows. The 504 fix (`c3a13a1`: DEFAULT_RANGE 80k->20k + bounded GHA loop) holds — 0 ERROR deploys.
- **`18897fd` — AllDay listing serials resolved on-chain (off the CF-1009 nflallday `/allday-consumer` path) — PASS -> RESOLVED.** `allday-listing-serial-backfill`: the `http_403:error 1009` failures STOPPED at the fix deploy. Two consecutive ok ticks post-fix: **03:34Z** (ok=true, 37 serials, 0 errors) and **06:34Z** (ok=true, 0 new serials, 0 borrow_errors). All 5 fails in 24h are PRE-fix (last 00:34Z). `allday_moment_serials` 2 -> 39; deal-board `low_ask_serial` populated. -> closes ALLDAY-SERIAL-BACKFILL-CRON (see section 4).
- **`cd92ec9` — historical spork buyer-backfill lane tuned (skip unreachable 2022, batch 40->120) — PASS.** The lane is LIVE (Trevor enabled the env flag + cron) and healthy: `topshot-buyer-backfill-historical` fires every 30 min (:12/:42), **ok=true, 0 decode_failed, 0 bailed_early**, batch 120 -> 120 buyers + 120 sellers + 120 exec-accounts resolved per run, ~28s duration, cursor walking the recoverable 2024 tail backward (2024-12 -> 2024-11). The batch 40->120 raise is live and working; no harm.
- **`93ff06c`/`f995ebe` — Special Serial Owners surface (RPC + gated board + concierge tool) — PASS (surface); the MV-refresh cron is the queued item.** Backing MV `topshot_special_serial_owners_mv` returns 5,929 rows (fresh — see section 3 manual refresh); 0 Sentry; security invariants clean (the SECDEF RPC + REVOKE-from-anon are intact, 0/0/0/0). Only the refresh-cron path is broken — see section 4 REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT.
- **BUYERBF-PERINVOCATION-WORK (forward buyer-backfill, `7a70a31`/`d717536`) — holding, not worsening.** `topshot-buyer-backfill` 64 runs / 0 fails / 24h, **max 740.2s** (= the 06-19 late peak, no further creep), under the 770s watch line and the 800s Pro cap. Item holds as queued (CC route + operator cron).

No shipped change correlated with a regression -> 0 auto-reverts.

## 2. Health-drift triage — GREEN

- **Security 0/0/0/0.** RLS-off public base tables `(none)`; anon/authenticated write on RLS-off base tables (relkind r/p) `(none)`; `check_public_security_invariants()` `[]`; `check_secdef_anon_execute_violations()` `[]`. (The un-filtered anon-write query false-positives on ~58 views — the documented relkind artifact, not a finding.)
- **`detect_stalled_pipelines()` `[]` · `get_pipeline_alerts()` `[]`.**
- **`v_rpc_trust_health` 9/9 ok** — edition_integrity 4/50, fmv_sanity 0/1, offer_edition_gap $0/50, pack_ev_board_stale 0.84d/2, pack_ev_depleted 0/30, pinnacle_ask 0.2h/3, pinnacle_fmv 22.0h/30, ts_uuid_dupes_24h 0/200, unmapped_resolution_backlog 10/100.
- **Sentinel TS-UUID-48h 0** (ts_uuid_keyed_48h 0; ts_uuid_dupes_created_24h 0).
- **FMV reconciles EXACTLY** to editions: TS 15,543 = 15,543; AllDay 6,191 = 6,191. TS HIGH+MED **3,332** (HIGH 896 / MED 2,436) — up from 3,144 baseline, improving; ASK_ONLY 2,421 (down from 2,622, not over-claiming); NO_DATA 3,371 (improving from 3,468). AllDay HIGH+MED **852** (HIGH 228 / MED 624).
- **Pipeline_runs 24h: 14 fails, all transient/known/resolved** — allday-listing-serial-backfill x5 (ALL pre-`18897fd`, last 00:34Z, none since), evm-transfers-ingest x4 (Base 429, benign), refresh-special-serial-owners-mv x2 (pre-04:38Z fix, the queued item), + the documented brief 19:15-19:29Z micro-contention cluster (alerts-dispatch / check-alerts / wmc-fmv-populate, 1 each).
- **Sentry 0 unresolved / 0 new** (the 06-19 NEXTJS-A smoke false-alarm has aged out).
- **Vercel 0 ERROR** across 20 recent; prod = `c3a13a1` READY (the two newer commits `24e1c30` docs + `8760bda` monitor -> CANCELED, superseded docs-only).
- **DB 4,899 MB** (+56 over ~1.5d vs the 06-19 4,843 baseline; benign creep). Editions flat (TS 15,543 / AllDay 6,191 / Golazos 581 / UFC 446). Open `unmapped_sales` 46 (ALLDAY-V1-UNMAPPED-DRIFT fossils, flat).

### Overnight deltas vs `metrics-latest.json` (06-19 baseline)
TS HIGH+MED 3,144 -> **3,332** (improving) · TS NO_DATA 3,468 -> **3,371** (improving) · TS ASK_ONLY 2,622 -> **2,421** (not over-claiming) · AllDay HIGH+MED 844 -> **852** · DB 4,843 -> **4,899 MB** · sentinel 0 -> 0 · unmapped 45 -> 46 · editions flat.

## 3. Artifacts — 14 active, all healthy, none repaired

Enumerated 14 active (5 RETIRED tombstones correctly absent). The 06:06Z monitor validated them GREEN ~2h prior; nothing schema-changed since except the special-serials MV (not an artifact backing object) + my manual refresh. Real spot-check of the backing objects: deals_board 813, serial_premiums 287, trophies 683, squeeze 9,102, top_sales 816, tracked_fmv 21, offer_sanity 234, special_serial_mv 5,929. All return rows. No drift -> **no repairs** (per the rule: don't regenerate working artifacts).

**Side effect (positive):** while verifying the REFRESH-SPECIAL item (section 4) I manually ran `refresh_topshot_special_serial_owners_mv()` to measure its duration — this **refreshed the MV with current holder data** (5,929 rows fresh as of tonight), so the Special Serial Owners board is current despite the broken cron.

## 4. Shipped / Closed / Queued

### SHIPPED (1, fresh-subagent-verified PASS)

**`audit_20260620_watchlist_allday_listing_serial_backfill`** — added a `pipeline_cadence_watchlist` row for `allday-listing-serial-backfill` (max_silent_minutes **600**, severity **medium**, is_active true). The on-chain serial backfill (`18897fd`) is now the sole source of deal-board `low_ask_serial`; this lets `detect_stalled_pipelines()` catch it if its 3-hourly (:34) cron dies. Gate met: 2 consecutive ok ticks (03:34Z / 06:34Z), clockwork ~180m cadence observed across 6 runs. 600m = ~3 missed ticks + grace -> tolerates 1-2 transient drops, fires only on a dead cron.
- **Verification:** row present + correct; `detect_stalled_pipelines()` returns `[]` (no false-positive; current silence 110m < 600m). Independent fresh-subagent (no prior context) re-ran all 4 checks -> **PASS** (row correct, no false-positive, threshold generous vs observed gaps, no regression; it independently confirmed the prior 1009 streak has cleared).
- **Revert:** `DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline='allday-listing-serial-backfill';`
- **Re-check tomorrow:** stays absent from `detect_stalled_pipelines()` while the cron fires 3-hourly; surfaces only if the cron genuinely dies (>600m silent).

### CLOSED (1)

**ALLDAY-SERIAL-BACKFILL-CRON** — RESOLVED by `18897fd` (serial source moved off the CF-1009 nflallday `/allday-consumer` path to on-chain `AllDay.borrowMomentNFT` via rest-mainnet). 1009 errors gone; 2 consecutive ok ticks (03:34Z = 37 serials, 06:34Z = 0 new/0 errors); `allday_moment_serials` 2 -> 39; deal-board `low_ask_serial` populated. Watchlist row added (above). Done.

### QUEUED — updated with new measured evidence (1)

**REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT** · [MED · CC route hot-file + deploy, OR a DB-only design call] · night-count 2.

- **What changed tonight:** the monitor's recommended fix was **already shipped** by Trevor/CC at **04:38Z** as `audit_20260620_refresh_special_serial_owners_mv_timeout_180s` (the SECDEF fn `refresh_topshot_special_serial_owners_mv()` now has `SET statement_timeout='180s'`, overriding the service_role 30s). The 2 failed runs (00:32Z, 02:16Z) predate it; the 06:06Z monitor read pipeline_runs but not the fn def, so it logged the fix as still-needed.
- **NEW finding (measured tonight):** the fn-timeout fix is **necessary but INSUFFICIENT.** I ran the refresh through the exact fn the cron calls and timed it: `REFRESH MATERIALIZED VIEW CONCURRENTLY topshot_special_serial_owners_mv` ran **>135s** (still active at 135s, completed before the 180s fn-timeout). That **exceeds the route's `maxDuration=120`** (`app/api/cron/refresh-special-serial-owners-mv/route.ts`, which runs the refresh in `after()`). So at the next cron tick the lambda is killed at 120s **before the refresh completes AND before `log_pipeline_run` fires** -> the cron now produces **NO pipeline_runs entry (silent failure)** instead of the prior logged `ok=false`. Worse for observability; the board keeps serving its snapshot (now freshly refreshed tonight). Root cause: the MV's base view full-scans TS `wallet_moments_cache` (~70s) and CONCURRENTLY roughly doubles that (diff/merge) -> 135-160s. The sibling it was modeled on (`refresh-pack-grail-metrics-mv`, maxDuration **60**) works only because its MV is tiny/fast (<60s); that route's own comment documents this exact silent-failure class.
- **Ready fixes (one of):**
  - **(A) CC, route hot-file + deploy:** raise `maxDuration` 120 -> **~200** in `app/api/cron/refresh-special-serial-owners-mv/route.ts` (keeps CONCURRENTLY non-blocking reads); AND bump the fn `statement_timeout` 180 -> **~210s** for margin (`ALTER FUNCTION public.refresh_topshot_special_serial_owners_mv() SET statement_timeout='210s';`) since 180s leaves thin headroom over a 135-160s refresh under load.
  - **(B) DB-only, but CC's design call:** change the fn body `REFRESH MATERIALIZED VIEW CONCURRENTLY` -> plain `REFRESH MATERIALIZED VIEW` (drops to ~70-90s, fits maxDuration=120), accepting a brief ~70-90s AccessExclusive lock per refresh (board reads block during it — fine on a low-cadence daily cron for an auth-gated/noindex board). This **reverses CC's deliberate CONCURRENTLY choice** + changes locking semantics on a SECDEF object shipped today, so it should be CC/Trevor's decision, not autonomous.
- **Why NOT night-pass-shipped:** the route is a hot file (committed `93ff06c`, ~8h ago); option (B) reverses an explicit CC design decision; blast radius is LOW (board serves its snapshot, refreshed tonight). When unsure -> queue.
- **Revert of the already-live 04:38Z fix (if ever needed):** `ALTER FUNCTION public.refresh_topshot_special_serial_owners_mv() SET statement_timeout='30s';` (leave it — it's correct, just insufficient alone).

### Carried (off-limits / operator / CC / Trevor — unchanged this run)
BUYERBF-PERINVOCATION-WORK (CC route + operator cron; max 740.2s, holding), UFC-EDITIONS-SEED-GAP (CC/operator), TS-WMC-UUID-FOSSILS (CC), ALLDAY-V1-UNMAPPED-DRIFT (operator/CC — 46 open, all `v1_tx_decode_budget_exhausted` fossils), N1 snapshot-institutional-wallets (operator), BADGE-CATALOG-CRONJOB-DUP (operator — delete a cron-job.org entry), VERCEL cost family (Trevor), A1-WORKER-PASSTHROUGH-CLEANUP (Trevor/wrangler), get_user_top_owned_moments 3-arg orphan (Trevor/CC destructive), PIN-FMV-REKEY-WAVES 2/3, PIN-SYNC-CRON, P3-BUYERS, DUPE1, Q2/Q5/Q6, ANALYTICS-SMOKE-RESIDUAL, IPFS x2.

### Operator hygiene (low, from the 06-20 06:06Z inbox — not night-pass actions)
- Disable the old cron-job.org "RPC Backfill Offer-Fill Sales" entry now that GHA `offer-fill-backfill.yml` owns the drain (`78ca042`); harmless 202+dropped-after() burn until then.

## 5. STEERS honored (did NOT re-flag)
SERIAL-FMV-MULT-CRON = BY DESIGN (weekly pg_cron jobs 5+6, Sun 11:00 UTC; next 06-21). evm-transfers-ingest Base-429 = benign. Alerts live with 1 sub (Trevor go-live) = intentional, not an anomaly. AllDay FMV NO_DATA elevated vs the old baseline = benign zero-90d-sale reclassification (reconciles exactly). The 19:15-19:29Z 1/96 alerts-dispatch deal-leg timeout is within tolerance, NOT a re-emergence of the closed ALERTS-DISPATCH-DEAL-TIMEOUT.

---
*Lock released. metrics-latest.json overwritten. Inbox (4 files) archived. Ledger + CLAUDE.md updated.*
