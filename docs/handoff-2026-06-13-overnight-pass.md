# Handoff — 2026-06-13 overnight autonomous pass

**Run:** rpc-nightly-autonomous-pass · **Fired:** 2026-06-13T08:02Z (01:02 PDT — GENUINE OVERNIGHT, in-window) · **Mode:** full (push available) · **Shipped:** 0 production changes / **Reverted:** 0 / **Repaired:** 0 artifacts.

**One-liner:** The cleanest night in two weeks. The Micro→Small Supabase compute upgrade (Trevor, 06-13) + the cohort-split wave pacing **decisively resolved** the 3-day DBSAT-IO-EXHAUSTION incident — the decisive 06:45–07:27Z cohort wave I was positioned to see absorbed **1,507 runs / 3 fails (0.2%)**, the post-wave window is near-spotless, and every closure candidate the monitor teed up cleared. Security 0/0, trust 8/8, detect_stalled `[]`, Sentry quiet. No genuinely-low-risk production change was warranted or fully-gated tonight, so I shipped none — this is the correct outcome the night after a major incident recovery. Closed 3 incident items, re-baselined metrics on the new tier, queued 3 refinements.

---

## Gates
- **Lock:** prior lock RELEASED + stale (17.5h old, 06-12T14:42Z). Took over; created HELD lock runid=2750515174; RELEASED at end.
- **FREEZE:** none.
- **Quiet-hours:** shell UTC 08:02Z = **01:02 PDT** (operator TZ), inside 00:00–06:00 → genuine overnight, normal shipping allowed.
- **Push:** available (`git push --dry-run` → up-to-date; sandbox-native clone `/tmp/rpc` from origin, authenticated pushurl harvested — never printed).
- **Collision gate:** origin/main = `0cb2501` at run start AND at run end (re-fetched before writing) — no human/CC push mid-run. Hot files (real commits <48h, untouched): app/api/ingest/route.ts, app/api/admin/backfill-topshot-buyers/route.ts, app/profile/[username]/*, app/(collections)/layout.tsx, app/(analytics)/analytics/layout.tsx, app/my-teams/layout.tsx, components/HomePageMarketing.tsx, proxy.ts, app/api/cron/ufc-enrichment-drain/route.ts, app/api/seed-wallet-refresh/route.ts.

## Reviewed
- **CLAUDE.md** in full; **ledger** in full (no populated "Declined" section — nothing hard-declined); **focus.md** (night-of-06-12→13 steer, §12 wave/§11 UFC/§10 pinnacle-index); **metrics-latest.json** (06-12 incident-partial); the **06-12 overnight handoff** + the **7 inbox files** (06-12T15:15Z → 06-13T06:15Z) drained + archived this run.
- **Post-ship regression watch** (last ~24–48h ships) — all PASS, 0 reverts (detail below).
- **Artifacts:** 17 enumerated (12 active + 5 intentional RETIRED tombstones). HTML lives under `C:\…\OneDrive\…\Artifacts\` — **outside this scheduled session's mounts**, so per-payload validation remains impossible from a scheduled run (MONITOR-ARTIFACT-ACCESS, carried). Instead I independently re-validated every active artifact's **backing surface** on the live DB: v_rpc_trust_health 8/8, FMV latest-per-edition histogram, pipeline_runs stats, security checks, v_tracked_wallet_fmv_confidence, v_offer_sanity_flags, v_rewards_economy, deploys/DB-size — **all green**. No artifact repair needed (and the focus §12c single-payload pattern / tombstone rule was respected: nothing touched).

## Section 2 — health-drift findings + overnight deltas

**DBSAT-IO-EXHAUSTION-0612 — RESOLVED (the §12f decision checkpoint passed).** Hourly fails/runs across the wave windows on the new Small tier (shared_buffers 512MB / max_connections 90 / effective_cache_size 1.5GB):

| Hour (UTC) | runs | fails | note |
|---|---|---|---|
| 06-13 00 | 730 | 1 | midnight wave |
| 06-13 01 | 1502 | 6 (0.4%) | cohort wave |
| 06-13 02–05 | 234/234/242/239 | 0/0/1/0 | near-spotless |
| 06-13 06 | 732 | 0 | pre-wave |
| **06-13 07** | **1507** | **3 (0.2%)** | **decisive cohort wave** |
| 06-13 08 | 23 | 0 | (partial, this run) |

The 07Z cohort wave — the one the 06:15Z monitor explicitly couldn't see and asked the night pass to judge — ran **cleaner than the 01Z wave**. Per focus §12f: clean = pacing + the compute add-on solved it. The 11 fails across the last 8h are *all* wave-coincident `wmc-fmv-populate` lock/statement-timeouts (×6, in the :45–:33 wave minutes) + `check-alerts`/`topshot-fmv-populate` statement-timeouts (×2 each, the :15 slots colliding with the wave) + one lone transient `pack-events-ingest` allday_pack_purchases abort @04:39Z. This is the per-wallet fan-out residual, far below alarm — not new regressions. **The compute add-on "open decision" is CLOSED** (Trevor upgraded the tier).

**UFC-WMC-NULLKEY — RESOLVED/CLOSED.** UFC wmc null `edition_key` = **2 / 4,584** (down from 256 @06:15Z, 3,837 @00:06Z, the 3,150 baseline). The wired decoupled `ufc-enrichment-drain` cron (CC `8535a2e`/`fb2fbac`, operator-wired ~04:37Z) drained the entire backlog to the expected fossil floor — the `0x6d1f8c18` nft_not_held pair (NFTs transferred away, permanent residual). Drain cron 8/8 ok, 30-min cadence, 0 fails. New rows are not re-leaking.

**LISTCACHE-SILENT-0612 — CLOSED on liveness.** `topshot-listing-cache` firing reliably: 04:46 / 00:00 / 06-12 22:18 / 20:34 / 18:18Z, all ok; cadence ~1.7–4.75h, the longest gap (00:00→04:46, 285m) still under the 360m watchlist threshold; detect_stalled clean. Residual question (operator, low): the ~2.5h cadence vs the historical ~20m — confirm whether that's the intended post-stagger interval or a cron-job.org frequency drift.

**Weekly DB maintenance — healthy; expectation corrected.** The self-fire leg (`prune-log-tables` route → `run_weekly_db_maintenance`, logged under pipeline `weekly-db-maintenance`) is gated on a **6-day dedupe window, not day-of-week**. Last successful weekly run 06-07 23:40Z (cleanly deleted 5,972 pipeline_runs). Today's 04:23Z daily `prune-log-tables` tick (ok=true) correctly no-op'd the weekly leg because 06-07 23:40Z is still inside the 6-day window (which expires 06-13 23:40Z, *after* the 04:23Z tick). **First re-fire is therefore ~06-14 04:23Z, not 06-13** as focus §9c estimated (the estimate was off by one tick because the daily slot is before the 23:40Z anniversary). Self-healing as designed — verify the 06-14 04:23Z `weekly-db-maintenance` row next pass.

**Security: 0/0 on all four checks.** RLS-off base tables `[]`; anon/authenticated write-grants on RLS-off base tables `[]` (with the mandatory `relkind IN ('r','p')` filter — without it the query false-positives on ~51 public views, which it did this run; re-ran filtered → clean); `check_secdef_anon_execute_violations()` `[]`; `check_public_security_invariants()` `[]`.

**Other health (all green):** detect_stalled_pipelines() `[]`; trust health **8/8 ok** (pinnacle_ask 0.2h, pinnacle_fmv 22.0h, fmv_sanity 0, offer_edition_gap 0, pack_ev_stale 1.12d, edition_integrity 4, ts_uuid_dupes_24h 0); sentinel TS-UUID-keyed-48h **0**; Sentry **2 unresolved** (NEXTJS-E nfl-all-day/overview-200 + NEXTJS-A fmv-pipeline-health, both 2 events, super_low, last seen 17h ago = the 06-12 ~15Z incident-window smoke echoes; predate the 06-13 CC commits → not regressions; approaching the 24h resolve-after-quiet mark ~15Z 06-13); Vercel prod = `0cb2501` READY, all recent deploys READY, the 4 ERRORs are the closed 06-12 13:53–15:13Z incident-window docs-only batch (VERCEL-DEPLOY-ERROR-X4, superseded by 8+ later READY).

**Overnight metric deltas (vs 06-12 incident-partial baseline / 06-15Z monitor):**
- FMV TS HIGH+MED **3,282** (950 HIGH / 2,332 MED) — up from 3,278 @06:15Z; NO_DATA 4,264 (falling from ~4,687). LOW 6,591, ASK_ONLY 949, STALE 433, SALES_ONLY 24.
- FMV AllDay HIGH+MED **657** / 6,191 (up from 655). Pinnacle per-render **805 / 1,830** HM (flat).
- editions: TS 15,543 / AllDay 6,191 / Golazos 581 / UFC 446 (flat).
- DB size **4,455 MB** (+33 vs 4,422 @06:15Z; +144 vs the 4,311 06-12 incident-partial baseline). Mild steady creep on the post-drop ~4.2GB baseline — watch-only. (pipeline_runs hasn't been pruned since 06-07; the 06-14 weekly fire will prune it.)
- unmapped_sales open: AllDay 214 + Golazos 1 = **215** (carry ~183; modest resolver-class drift, watch).

## Post-ship regression watch (last 24–48h ships) — ALL PASS, 0 reverts
- **`8535a2e`/`fb2fbac` (ufc-enrichment-drain decoupled cron)** — target metric (UFC null edition_key) went 3,837→**2** (fossil floor); drain cron 8/8 ok. PASS.
- **`1d79539` + `83bb40f` (TS buyer-backfill widen + `source=topshot_gql` label)** — `topshot-buyer-backfill` 48/0 in 8h; monitor confirmed 300/tick @100% buyer/seller/exec resolution, 0 decode failures, cursor working back through the backlog. PASS.
- **`eba6491` + cron 4-entry cohort split (Cowork/operator)** — the 01Z (1502/6) and 07Z (1507/3) waves both clean; wave pacing working as designed. PASS.
- **`d0acecf` (offers per-moment + edition-grain on-chain raise)** — trust-health `offer_edition_gap_max_usd` = 0 (ok). PASS.
- **`b566482` (profile SSR portfolio FMV/moments + $0 unfurl keying)** — no profile-attributable Sentry; no new errors. PASS (frontend ship; verified via Sentry-quiet + analytics-smoke green).
- **`6d8c1e4` (cx first-impression batch — touched proxy.ts, layouts, HomePageMarketing)** — security 0/0 (proxy.ts isPublicPath change opened no anon-write hole); analytics-smoke 16/0 (public-page smoke green); only Sentry issues are the 2 stale incident-echoes, neither cx-attributable. PASS.
- **`46500e4` (tshb 120s budget under 300s cap)** — monitor confirmed badge-sync + tshb GHA healthy; ASK_ONLY drain proceeding. PASS (carried from monitor).
- Streaks re-confirmed: fmv-recalc 26/0 (fully recovered), offers-sweep 24/0, analytics-smoke 16/0 (60s restore holding).

## SHIPPED this run
**None (0 production-affecting changes).** No genuinely-low-risk, fully-gated, needed change existed tonight:
- The focus §10a pinnacle render_id partial index (`idx_wmc_pinnacle_render_id_null`) **already exists, valid + ready**, and Pinnacle wmc `null_render` = **0** (backfill complete) — already done/moot, nothing to ship. The lone 07:37Z `pinnacle-wmc-render-id` fail is an *upstream* request timeout (transient, wave-window), not the DB statement timeout an index addresses.
- TFP-480-RESTORE gate **not met** (both gate ticks 01:15Z + 07:15Z failed under the cohort wave).
- ufc-enrichment-drain watchlist candidate has only **3.5h** of observed cadence (started 04:37Z) — under the 24–48h cadence gate (BUYERBF lesson).

Doc/ledger/metrics/CLAUDE.md updates + inbox archival were committed (low-stakes, not production-affecting).

## QUEUED (carried + new)

**NEW this run:**
- **UFC-DRAIN-WATCHLIST** · [LOW · night-pass-shippable once 24–48h steady cadence observed, ~06-14/06-15] watchlist the now load-bearing `ufc-enrichment-drain` (the sole UFC edition_key source). Observed only ~3.5h tonight (first run 06-13 04:37Z, perfect 30-min cadence, 8/8 ok, max_gap=30m) — too short to set a non-false-positiving threshold per the BUYERBF lesson. Ready INSERT once gated: `INSERT INTO pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, is_active, notes) VALUES ('ufc-enrichment-drain', 120, 'medium', true, 'Decoupled UFC wmc edition_key enrichment drain, :07/:37 (~30m). 120m = ~3 missed ticks + margin. Sole UFC edition_key source post fb2fbac/8535a2e.') ON CONFLICT (pipeline) DO NOTHING;` Revert: `DELETE FROM pipeline_cadence_watchlist WHERE pipeline='ufc-enrichment-drain';` NOTE: it began as a finite backlog drain (now at the fossil floor); it stays live for the ongoing trickle, so keep it active (unlike migrate-wmc).
- **TFP-SLOT-WAVE-COLLISION** (refines TFP-480-RESTORE) · [operator cron-job.org] `topshot-fmv-populate`'s :15 slot (hours 1,7,13,19) now deterministically lands inside the cohort wave (the 4 cohort entries fire :45/:59/:13/:27 around the 0/6/12/18h seed-refresh waves), so its 01:15Z + 07:15Z ticks both statement-timeout — which keeps **resetting the TFP-480-RESTORE "2 consecutive clean ticks" gate**. TFP is a heavy GQL FMV populate and is the known DB-IO barometer (focus §12e). Durable fix: move TFP's cron slot off :15 to a calm minute (~:35–:40, between the :27 and :45 cohort ticks); then the 480-restore gate can actually pass. Until then TFP-480-RESTORE stays blocked.

**Carried (ship-ready, gate-blocked):**
- **TFP-480-RESTORE** · [ship-ready · gate NOT met] `UPDATE pipeline_cadence_watchlist SET max_silent_minutes=480 WHERE pipeline='topshot-fmv-populate';` (currently 800m; revert = set 800). Gate: 2 consecutive ok ticks OUTSIDE a saturation/wave window. Last 2 ticks (01:15Z, 07:15Z) failed under the cohort wave (see TFP-SLOT-WAVE-COLLISION — likely needs the slot move first).
- **MONITOR-ARTIFACT-ACCESS** · [LOW · interactive Cowork session w/ artifact access, or Trevor] export the 12 active artifacts' single-payload queries to a repo doc (e.g. `docs/operations/artifact-payloads.md`) so scheduled monitor/night-pass runs can validate payloads, not just backing surfaces. Scheduled sessions can't read `C:\…\OneDrive\…\Artifacts\` (outside mounts) — the night pass faces the same wall as the monitor, so this can't be built from a scheduled run. Backing surfaces independently validated green this run as the interim.

**Carried (operator / CC / Trevor — unchanged):** ANALYTICS-SMOKE-RESIDUAL (CC, restore 110s→60s after the leg fixes); OFFER-SANITY-RAISE (Trevor product call + operator wiring — edition-level raise, 30 real cases, + companion monitor); TEAM-MOMENT-DISPLAY (CC display); TS-SALES-INGEST-GAP / ASK-ONLY Phase 2 (CC build, LiveToken-gated); PIN-FMV-REKEY-WAVES 2/3 (Trevor); PACKVIZ-GRID (CC review); TSHB drain (GHA throttle, monitor); IPFS-CIDSET-EVENT-LEG + IPFS-GATEWAY-FALLBACK (deferred, trigger-gated); P3-BUYERS / N1 (operator cron-watch); Q5/Q6/Q8 (CC); SMOKE-EDITION-TIMEOUT (CC, hot file); NEXTJS-15/Q4 watch; CRON-30S 3/4 + token hygiene (operator). LISTCACHE cadence frequency check (operator, low).

## FAILED / BLOCKED / AUTO-REVERTED
None. No verification failures; no shipping hard-stop; nothing reverted.

## For the next pass / monitor to verify
1. The 12:45–13:27Z + 18:45–19:27Z cohort waves stay clean (DBSAT closure holds across a full day on the Small tier).
2. `weekly-db-maintenance` first re-fire ~06-14 04:23Z (the 6-day window from 06-07 23:40Z expires 06-13 23:40Z).
3. UFC null edition_key holds at ~2 (fossil floor) — confirm the drain keeps new rows from leaking, then ship UFC-DRAIN-WATCHLIST once ~24–48h cadence is banked.
4. The 2 stale smoke Sentry issues (NEXTJS-E/A) resolvable after 24h quiet (~15Z 06-13) with regression arming.
