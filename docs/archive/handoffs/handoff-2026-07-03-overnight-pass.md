# RPC nightly autonomous pass — handoff 2026-07-03

**Mode:** GENUINE OVERNIGHT, in-window (fired 08:02Z / **01:02 PDT**). **No clock skew** — shell `date` 08:02:09Z ≈ DB `now()` 08:02:30Z ≈ app-stamped `sales.ingested_at` 07:56Z / `fmv.computed_at` 07:58Z (production rows can't be future-stamped, so they bound real time). Push available (`git push --dry-run` = up-to-date). No `FREEZE.md`. Lock was RELEASED (last night); took it (run-70b4ba3f).

**Git:** sandbox clone `$HOME/rpcwork`; origin/main `5f0c00b5` unchanged start→end. **Shipped 0** production changes (correct — see below), reverted 0, repaired 0, closed 0. Docs-only commit this run (handoff + ledger + metrics + CLAUDE.md entry). **Inbox EMPTY** — the 07-02 daytime was an interactive Claude Code P1–P8 session (not monitor ticks), so no candidate files were queued; candidate sources reduced to the ledger queue + CLAUDE.md open lists + the Section-2 health triage.

The value of tonight's run was the **independent post-ship watch on the heavy 07-02 CC wave** (which had not yet been through one) + full health verification. A quiet, honest night.

---

## Why shipped 0 (correct)

- **Inbox empty** → no daytime-monitor candidates.
- Every queued item is **off-limits / owned / operator / gated / CC route-logic / FMV-adjacent-unverifiable** (classify-acq route logic, SERIAL-FMV weekly-timeout, the operator P8 finite-drain residual, etc.).
- The only new health signal (2 pg_cron timeouts) is **single-tick transient contention**, not a fixable pattern — a `statement_timeout` bump on a single 06:23Z failure is the repeatedly-queued-not-shipped anti-pattern (premature, contention-root, unverifiable in-run).
- Health GREEN, all 15 artifacts healthy, no broken-artifact repair, no clear Sentry/error fix.

---

## Post-ship regression watch — the 07-02 daytime CC wave — ALL PASS, 0 reverts

Re-measured the whole 07-02 daytime/evening wave (`00fc4ee4`→`5f0c00b5`, ~16h after the last code commit). Prod = `dpl_Pi13AZqbq9gTfDa16iSrSswt16nJ` (SHA `1cd46de9`, the P8 writer guard) **READY** — contains the entire code wave; the two newer commits (`6b6bd976`, `5f0c00b5`) are docs-only → CANCELED via the docs `ignoreCommand` (correct). No ERROR-state deploys.

- **P1b — FMV disconnected-ASK model clamp (`ed10bb9`, `78501ba`) — HOLDING.** The Step-10 **inline clamp fires on every `fmv-recalc` run** (last 8 runs `extra.disconnected_ask_clamp_rows` = 86, 2, 6, 25, 59, 87, 3, 8, **all ok=true**) → born-clamped, no 23h lag. The independent daily crons are alive: `rpc-refresh-fmv-display-guard` (13:45Z ok) + `rpc-refresh-thin-fmv-guard` (13:30Z ok); the model-clamp backstop cron `rpc-fmv-clamp-disconnected-ask` (`55 13`, jobid 34) shows `last_run=null` because it was created after 13:55Z on 07-02, so its **first scheduled tick is 07-03 13:55Z** — expected, and the inline Step-10 path is the real-time clamp regardless. `topshot_fmv_display_guard` fresh (1,382 rows / 452 `fmv_exceeds_max` / **0 `fmv_disconnected`** = source already clean). **The egregious fake-deal class is gone:** the residual detector (`fmv>3×median AND fmv>1.5×p90`, n≥5) reads **35 (24 LOW/ASK)**, but the worst genuine escape (>1.15× clamp target) is `171:6497` at **$0.85 vs $0.45 target** — i.e. all residual is sub-$1 floor commons + rounding-artifact at-target rows, **no economically-meaningful fake deal** (the $42.50 / $170 / $2,924 disconnected FMVs P1b targeted are all resolved). TS FMV **H+M 4,756** (up from 4,710), HIGH/MED untouched by the LOW/ASK-only clamp; `fmv_sanity_flags` 0.
- **P3 — UFC ipfs-media proxy (`249d5808`, `e839670`) — PASS.** Vercel runtime errors (18h) show **no `/api/public/ipfs-media` class and no new class of any kind**; all families are long-standing (url.parse DEP0169, route pool/statement timeouts, wmc idempotent dup-key). The superseded pack-sniper errors trace to older deploy `dpl_DYCAC`, not current prod.
- **P7 — offer_fill writer guard (`61f5a7c`) — PASS.** `source='offer_fill'` sales flowing healthily: **4,515 in 7d, latest sale 07:28Z / ingest 07:32Z**; guard not blocking legit inserts; editions FLAT (no leak).
- **P8 — `replace_topshot_moments_batch` parallel guard (`1cd46de`) — HOLDING.** Newest surviving impossible-parallel moment is **07-02 18:42Z**, which is **~2.5h BEFORE the guard shipped (21:13Z)**, and **0 created in the ~13h since** → the guard stopped the ~325/24h hydrator leak. Total impossible-parallel moments fell **464 → 169** because an operator fired the finite drain (`topshot-p8-moment-drain` ran 07-02 23:37Z, `rows_written=174`) — exactly the designed workflow (guard the writer, then fire the one-shot drain). The remaining **169** are the on-chain-collision / deferred residual for a follow-up operator drain pass (proxy-cred'd, deployed-route-only — not autonomous).
- **Security 0/0/0/0** after all wave migrations (`invariants` / `anon_write_holes` / `rls_off_base_tables` / `secdef_anon_violations` all `[]`).

---

## Section 2 — health-drift triage (deltas vs 2026-07-02 metrics)

**GREEN.** `rpc_ops_snapshot()` baseline at 08:03Z:

- **Security** 0/0/0/0.
- **Trust health 16/16 ok, breaches `[]`.** (16 vs 15 last night — the new metric `topshot_impossible_parallel_serials` = 1/3, added by the P7/P8 parallel work.) Notables: unmapped 29/100, edition_integrity_flags 4/50, fmv_sanity 0/1, pinnacle_fmv_stale_hours 21.9/30, topshot_fmv_stale 0.2/6, ts_uuid_dupes_created_24h 0/200.
- **`detect_stalled_pipelines()` `[]`**; **`get_pipeline_alerts()`** 1 INFO (ufc_sales resolving_editions, benign, 22/24h).
- **`check_pgcron_recent_failures()` = 2, both transient** (see WATCH item below).
- **Sentinel TS-UUID-editions-48h = 0.**
- **Editions FLAT** vs 07-02 (identical): TS 17,489 / AllDay 6,191 / Golazos 581 / UFC 518.
- **FMV:** TS H+M **4,710→4,756** (+46, improving); AllDay **882→863** (MED 643→623, ASK_ONLY 1,309→1,341 = the documented benign re-bucket as `allday_studio_history_v1` keeps filling; editions FLAT, not a regression); UFC 15; Golazos 5.
- **pipeline_runs 24h fails:** 11 pipelines (wallet-backfill-multicollection-complete 14, pinnacle-nft-resolver 9, wmc-fmv-populate 9, fmv-recalc 6, compute-topshot-pack-ev 4, classify-acq 3, +5 fewer) — **all 11 verified latest-run ok=true** (transient pool contention).
- **DB 7,212→7,424 MB (+212).** Dominated by `allday_studio_history_v1` still filling (**254,859 rows, latest ingest 07-03 06:56Z**; golazos/ufc studio sources dormant since 06-26). Benign per focus.md; **watch the tail** — 9 days running, longer than the ~1–4d estimate, but AllDay has deep history.
- **Sentry** not separately loaded; Vercel `get_runtime_errors` (18h) used as the frontend-error proxy — all known families, **no new class** attributable to any 07-02 commit.
- **Vercel** prod `dpl_Pi13…` (1cd46de) READY; no ERROR deploys in last 20.
- **Artifacts** 15 in manifest, none flagged broken, none repaired.

---

## Needs your decision — queued

### NEW this run

- **OVERNIGHT-0623Z-CONTENTION-CLUSTER (LOW; night-count 1; WATCH, do NOT ship yet).** Two pg_cron jobs each timed out **only the 07-03 06:23Z tick** then are expected to recover at 12:23Z: `rpc-remap-misattributed-sales` (06:23Z FAIL 123s; the other 5/6 ticks in 32h ok 36–83s) and `rpc-allday-ev-corrected-refresh` (06:23Z FAIL 120.5s; other 5/6 ticks ok 5–19s). Root = the recurring overnight-backfill I/O contention window (same 06:21–06:22Z window as the pack-detail / edition pool-timeout runtime errors), **not a growing-table cliff yet**. Note: `rpc-remap-misattributed-sales` durations are creeping (36→44→83→123s) as `sales` grows, so if it starts failing **multiple** ticks it graduates to the classify-acq class (fix = bound its `win_sales` CTE to a recent window; the P7/P8 writer guards mean the mis-attribution set it converges is already shrinking). **Not auto-shipped:** a `statement_timeout` bump on a single transient is premature, addresses the timeout not the contention, and can't be verified in-run (next tick 12:23Z is after run end).

### Carried (unchanged unless noted)

- **CLASSIFY-ACQ-ALLDAY-STATEMENT-TIMEOUT (night-count 3; CC route/operator; do NOT close).** Still flapping (3 fails/24h; latest 08:06Z ok 43.5s) as `allday_studio_history_v1` fills the candidate-CTE scan. Same diagnosis/levers as night-count 2 (route runs in `after()` under maxDuration=120 with fn=90s → naive bump risks invisible lambda-kill; no clean index fix; durable = let it settle post-backfill + re-measure, or bound the candidate CTE to a recent window).
- **SERIAL-FMV-POWER-MODEL-WEEKLY-TIMEOUT (night-count 4; resurfaces 07-05).** FMV-adjacent + unverifiable-in-run; ready `ALTER FUNCTION … SET statement_timeout '600s'`.
- **Operator P8 finite-drain residual** — 169 impossible-parallel moments remain (writer now guarded; needs another `?p8=1&rekey=1` drain pass, proxy-cred'd deployed route).
- SMOKE-SECURITY-GUARD-TRANSIENT-API-PROBE-DEBUG; REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT; BUYERBF-PERINVOCATION-WORK; ALLDAY-V1-UNMAPPED-DRIFT (owned); WEEKLY-SURFACE-QA-PROSE; THIN-FMV-GUARD-CONTENTION; refresh-conflated-editions cron (operator); topshot-sales-history-backfill watchlist; VERCEL cost family; A1-WORKER-PASSTHROUGH-CLEANUP; PIN-FMV-REKEY-WAVES 2/3; PIN-SYNC-CRON; P3-BUYERS; DUPE1 (gated/CC); Q2/Q5/Q6; N1; ANALYTICS-SMOKE-RESIDUAL; IPFS ×2; P4a/P4b (env-blocked); P5 Pinnacle pack-EV (gated on Trevor).

**STEER honored:** SERIAL-FMV weekly by design; evm-429 benign; AllDay studio-backfill volume expected (do NOT flag); HISTORY-BACKFILL-UNMAPPED-SPIKE drain owned (do NOT re-flag).

---

## Failed / blocked / auto-reverted

None. Nothing errored; nothing shipped; no revert needed. Push available; connectors (Supabase + Vercel + Cowork artifacts) all healthy. Sentry connector not loaded (Vercel runtime errors used as proxy — comprehensive, no new class).
