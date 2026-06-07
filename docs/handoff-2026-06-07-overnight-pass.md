# Overnight autonomous pass — 2026-06-07 (OFF-HOURS MONITOR-MODE + NO-PUSH)

Run fired 13:56 UTC = **06:55 PDT — outside the 00:00–06:00 window → MONITOR-MODE** (queue, don't ship). `git push --dry-run` → no credentials → **NO-PUSH** also in effect (bot clone still unmounted; shared repo used read-only for git). No FREEZE. Prior `.lock` was a released marker (>45min) — taken over and released at end. **Shipped: NOTHING (0 migrations, 0 deploys, 0 artifact repairs needed). Auto-reverted: NOTHING — every recent ship is green or improving.** All outputs on disk, uncommitted (push unavailable).

HEAD = origin/main = `87b9d57` throughout the run (no mid-run advancement). 53 commits landed in the prior 48h (Trevor/CC/Cowork: PIN-FMV-REKEY waves 1a/1b/2/3-partial, CRON-30S, PIN-SYNC-FLOWTY, PACKVIZ, SMOKE-RETRY, pack-ev v21, cron-auth) — this run's main job was verifying that wave, and it verifies clean.

---

## 1. Post-ship regression watch (all GREEN — nothing reverted)

| Ship | Target metric | Tonight's measurement | Verdict |
|---|---|---|---|
| **pack-ev v21** `f39761a` (per-pack fetch timeout, PACKEV-BUDGET-2) | counters vary tick-to-tick, ev_rows>0, wedge broken | Last `time_budget_exceeded_after_fetch` **04:38Z** (v21 live ~05:10Z); since then every tick ok: nodes=4, ev_rows 3–4, pool_rows 21–294 (varying), fetch 10–30s of ~125s budget; oldest target **advancing** (06-04 10:09 → 06-04 14:39) | **WORKING** — wedge structurally broken. Remaining: throughput (see PACKEV-THROUGHPUT, §4) |
| **cron-auth Bearer** `9d35a48` + operator cron re-fire (ALLDAY-FMV-STALL) | allday-fmv-populate resumes | Resumed **08:22Z**, clockwork :02/:22/:42 since, 0 fails (one missed tick at the 12:0xZ rush only) | **RESOLVED** |
| **P1-CAD** `bf4c38c` | :22 ticks ok=true, cat_upserted>0 | 02:22→13:22Z **all ok=true**, catalog_upserted 1–13/tick | **HOLDING** (but serials_filled=0 → new PIN-SER, §4) |
| **TFP / CRON-30S** `36eee2f` + operator slot move (TFP-RUSH) | first ok=true post-slot-move | `topshot-fmv-populate` **06:50Z ok=true + 12:50Z ok=true** (slot moved off :00 → :50; first successes since 06-05 18:00Z) | **RESOLVED** — watchlist gate met → TFP-WATCH ready-to-run (§4) |
| **DUPE1-MIT** (drain_fmv_cold_tail skip-inert) | cold-tail stamp volume collapses | cold-tail snapshots last 24h = **156** (pre-fix ~2,675/24h) — **−94%** | **WORKING** |
| **AF1-v2** (EXISTS semi-join view) | GROUP BY completes, no 57014 | Completes, 7 buckets (also passed monitor 21:10Z + 00:50Z) | **HOLDING** |
| **PIN-FMV-REKEY waves 1a/1b/2/3-partial + Phase A** | renders priced, sales render-keyed, sync logs | 1,794/2,079 renders priced (1,789→1,794 daily advance), floor_ask 1,967; `pinnacle-sync` 10:07Z ok=true + `pinnacle-fmv-recalc` ok=true (PIN-SYNC-CRON appears wired); scarcity board alive (bounded 501); wmc image 99.8% platform-wide | **HEALTHY** |
| **SMOKE-RETRY** `ff853a2` | no smoke Sentry at routine rushes | 00:00Z + 12:00Z rushes clean; 06:5xZ rush DID punch through (4 checks, I1-class, single run, recovered — §2) | working as designed; I1 is the residual |
| **Wave-3 health-view re-points + 5 orphan fn drops** | no reader errors | No errors in any validated artifact/sweep query; health views exercised by 10:07Z sync run | **CLEAN** |

## 2. Health-drift triage

- **Security: 0 / 0** — 0 RLS-off public base tables; 0 anon/auth write grants on RLS-off base tables (`relkind IN ('r','p')` — the unfiltered task-prompt query false-positives ~50 views, ignored per CLAUDE.md).
- **`detect_stalled_pipelines()` = `[]`** and **`get_pipeline_alerts()` = `[]`**. N1 `snapshot-institutional-wallets` RECOVERED (ok=true 02:14:32Z 06-07, 3rd stall cleared; keep the operator rec: move its 06:00Z slot off the rush).
- **Sentinel TS-UUID-48h = 2,644** — still ≥2000 CRITICAL but **0 new in the last hour** (re-mint fully stopped); pure 48h roll-off, on track to clear below threshold ~today. TS editions flat at 15,541 since 06-06 18:36Z.
- **Pipelines 24h:** only known classes. compute-topshot-pack-ev 19 fails = the pre-v21 wedge (ended 04:38Z) + one 12:08Z pool timeout; pinnacle-nft-resolver 7/296, hydrator 5/136 (N2), wmc-fmv-populate 3/329, rest 1–2 each at rush minutes. `pinnacle-metadata-backfill` 4 fails all ≤06-06 17:22Z (pre-P1-CAD-fix).
- **I1 saturation class — recurring but milder than 06-06 18:xxZ:** 06:00Z window = 5 fails/5 pipelines; 12:00Z = 8 fails/7 pipelines; **no user-facing repeat observed**; the 06:5xZ smoke run failed 4 checks (NEXTJS-1E/A/W/E — detect_stalled RPC timeout + fmv-health + pinnacle/nfl overview 200s), single run, self-recovered, quiet ~7h since. wmc autovacuum tuning + cron stagger stay queued (§4).
- **Sentry: 6 unresolved, all known classes** — 5 smoke checks (the 18:5xZ 06-06 saturation echo + the 06:5xZ 06-07 recurrence; NEXTJS-4 now 3 events, its 24h-quiet clock restarted ~06:55Z) + NEXTJS-15 (1 event at the 06-06 saturation window, gated capture working). Nothing code-attributable; housekeeping = mark resolved after a quiet 24h (operator).
- **Deploys:** prod = `87b9d57` READY (tip). 04:46Z monitor verified 20/20 READY; only one deploy since (the inbox commit itself), READY.
- **Sales ingestion fresh:** TS 3,863 / AllDay 297 in 24h, both minutes old at sweep. `v_fmv_sanity_flags` = 0. unmapped_sales open 183 (flat).
- **Artifacts: 16/16 healthy, none repaired.** Fragile backers validated live tonight: AF1 view ✓, squeeze bounded 501 ✓, pack-reality 1 row (= C2, by-design thin), v_offer_sanity_flags 132 ✓, rewards/offers validated 04:46Z by monitor; nothing schema-changing landed since.

### Overnight deltas (vs metrics-latest.json baseline 06-06 08:30Z)

| metric | baseline | tonight | read |
|---|---|---|---|
| TS FMV HIGH+MED | 3,041 | **3,008** (564 H / 2,444 M) | churn-range flat (dipped 3,002 at 04:46Z, recovering) |
| AllDay HIGH+MED | 490 | **493** | flat-to-up |
| TS NO_DATA | 5,444 | **5,444** | stable — DUPE1-MIT holding |
| TS editions | 14,999 | **15,541** | +542, flat since 06-06 18:36Z (re-mint stopped) |
| sentinel TS-UUID-48h | 5,840 | **2,644** (0/hr) | draining, clears ~today |
| unmapped open | 162 | **183** | +21, flat since 06-06 21:12Z |
| DB size | 6,257 MB | **6,398 MB** | +141 |
| pack-EV stale-24h | (547 @ 00:50Z) | **665/800; stale-48h 330** | compounding at batch=4 → PACKEV-THROUGHPUT |
| wmc image coverage | 97.5% | **99.8%** (1,583,809/1,587,359) | a2cae0d + render re-key complete |

## 3. Shipped this run

**Nothing** (off-hours monitor-mode). No artifact repairs were needed either.

## 4. Queued (ready-to-run where possible)

1. **TFP-WATCH (NEW · SHIP-eligible next in-window run · monitoring INSERT).** Gate from TFP-RUSH is met: `topshot-fmv-populate` 2 consecutive ok=true (06:50Z, 12:50Z) after the operator moved its cron slot to :50. Ready migration (recommend 780m = tolerates one skipped ~6h tick, C-PIN lesson; tighten to 480m after a week of clean cadence):
   `INSERT INTO pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, is_active, notes) VALUES ('topshot-fmv-populate', 780, 'medium', true, 'TS marketplace-GQL FMV writer (upsert_topshot_marketplace_fmv). Cron ~6h at :50 (moved off :00 rush 2026-06-07). 780m tolerates one skipped tick; tighten to 480m after a clean week. CRON-30S fire-and-forget route.') ON CONFLICT (pipeline) DO NOTHING;`
   Revert: `DELETE FROM pipeline_cadence_watchlist WHERE pipeline='topshot-fmv-populate';`
2. **PACKEV-THROUGHPUT (NEW · CC, edge fn `compute-topshot-pack-ev`).** v21 broke the wedge but batch_size=4 yields ~6–8 EV rows/hr vs ~33 needed for 24h freshness on 800 targets; stale-24h 547→665, stale-48h 221→330 in ~13h. Evidence the budget has headroom: fetch phase 10–30s of ~125s every tick. Fix: raise batch_size 4→10–12 (per-pack timeout now makes head-of-line blockage impossible), or shorten the tick interval. Verify after: stale-24h trending down within 12h, oldest `last_ev_at` advancing >1 day/day.
3. **PIN-SER (NEW · CC, route `pinnacle-metadata-backfill`).** Q5 serial backfill selects a full queue every tick (`q5_eligible: 80`) but **`serials_filled: 0` across all ~20 post-P1-CAD ticks**; 21,564 eligible wmc rows (serial-null on `is_serialized=true` editions, of 32,451 total Pinnacle serial-nulls); runs complete in ~9s (no deadline starvation), `gql_errors: 0`, `error_samples: []`. So candidates are tagged but nothing writes — hypothesis: the per-wallet Cadence walk isn't returning `serialNumber` (nil for every walked NFT?) or Q5-tagged jobs aren't folded into the fetch loop. Next step: single-wallet live probe of `PINNACLE_METADATA_SCRIPT` against a known serialized-edition holder; confirm `info.serialNumber` arrives non-nil, then trace the L556–571 update path. No FMV impact (render-keyed); affects serial display only.
4. **I1 (carried · operator/CC) — rush-window DB saturation.** Recurring at :00 rushes (06:5xZ smoke-visible; 12:0xZ 8 fails/7 pipelines) but no repeat of the 06-06 user-facing episode. Queued actions unchanged: quantify wmc UPDATE volume per writer, stagger heavy wmc writers off :00/:20 (operator cron offsets), consider per-table autovacuum tuning migration on wmc (rpc-migration checklist).
5. **PIN-SYNC-CRON (carried · nearly done).** Daily cron appears wired (`pinnacle-sync` 10:07Z ok=true). After a 2nd daily tick (~06-08 10:07Z) confirms cadence, the watchlist INSERT in the ledger entry is ready (1560m/medium).
6. **C2 — CLOSED as analysis (board is honestly thin).** `topshot_pack_reality_top_ev` = 1 row because only **2** TS packs pass the substantive gates at all (positive-EV + priced + non-reward + depletion<90 + coverage≥40), 1 of which is fresh-48h. Not a freshness-gate artifact, not a bug — the market genuinely has ~1–2 positive-EV packs. Do NOT loosen the honesty gates. Optional LOW (CC): a thin-state caption on the public page ("Only N packs currently clear our honesty gates").
7. **Sentry housekeeping (operator):** after a quiet 24h (~06:55Z 06-08), resolve NEXTJS-1E/A/W/E/4; NEXTJS-15 stays (PIN1 class).
   - **SMOKE-MARKET-EMPTY (NEW · CC, from the concurrent 13:58Z monitor, adopted):** NEXTJS-4's deeper read — the market-API assertion likely fails on the TS GQL proxy returning green-but-empty at rushes (`tsCount: 0` class); assertion failures bypass SMOKE-RETRY by design. Fix: `/api/market` treats tsCount=0 as transient/typed failure so the retry covers it, or one-shot in-route retry on empty GQL.
   - **NIGHTPASS-MISS (operator):** this pass fired at 06:55 PDT, ~7h past the 1am trigger — 5th late/off-hours fire in ~9 runs. The monitor flagged it independently. Check the `rpc-nightly-autonomous-pass` scheduled-task trigger in Cowork (Scheduled) — likely the app was closed overnight; consider whether scheduled runs need the machine/app awake at 01:00.
8. **Carried:** DUPE1 (sentinel clears ~today; durable fix = Item B2 worker code), N1 (slot move DONE — ran ok 07:25Z off the rush; close after 2 more clean daily slots), N2, N3, L1, PIN1, CROSS1 (`refresh-cross-collection` still 0 runs — operator cron), P3-BUYERS, CRON-30S items 3/4 + `?token=` hygiene, Q2, Q5, Q6, Q7 (push/bot-clone infra — confirmed again this run), Q8, F1/F2-TierB, PIN-FMV-REKEY waves 2-remainder/3, PACKVIZ-GRID.
9. **C1 — CLOSED.** Catalog/wmc halves verified by the 06-06 monitor (2,079/2,079 thumbnails; wmc render_id + image_url 100%); the pin-page art rendering live (Wave 1b, Trevor-verified) supersedes the route smoke this sandbox can't perform (fetch provenance restriction). Remaining one-liner for any CC session: bogus-renderId → 404 check on `/api/public/pinnacle-image/[renderId]`.
10. **C3 — DONE.** `v_offer_sanity_flags` baseline recorded in metrics-latest.json: **132** (day range 118–138). Flag only on step-change.

## 5. Failed / blocked / reverted

Nothing failed, nothing reverted. Blocked-by-environment: git push (Q7), live HTTP smokes (fetch provenance restriction).

## 6. Continuity

Ledger updated; **7** inbox files (06-06T15:06Z → 06-07T13:58Z — the last landed mid-run from the concurrent daytime monitor, which independently confirmed every verdict here) archived to `docs/overnight/inbox/archive/`; `metrics-latest.json` overwritten (was ~30h stale); CLAUDE.md Recent sessions prepended; `.lock` released. All uncommitted (NO-PUSH) — next pushing session should sweep these in (the b7a950d pattern).
