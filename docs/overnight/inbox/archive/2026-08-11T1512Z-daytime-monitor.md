# Daytime monitor — 2026-08-11T15:12Z (08:12 PDT) — FIRST TICK OF DAY

Environment: workspace shell DOWN again (`useradd … /sessions no space left`, now 6th+ consecutive incident) → no git clone. Connectors (Supabase/Vercel/Sentry/cowork) + file tools work. This file written to the MOUNT; **push unavailable** — night pass picks it up locally.

Health: security 4/4 clean (invariants/anon-write/rls-off/secdef-anon all `[]`) · Vercel last prod deploy READY (`dpl_DU5kUALxARV3ZtLvuTH1zVZJ9NdM`=`030b9fa6`; the CANCELED tail is superseded-by-newer-push from heavy Trevor/CC activity today, no ERROR) · 0 new Sentry/12h · DB 12,499 MB · sentinel TS-uuid-48h 0 · **First-tick extras:** trust-health via snapshot (below), cross-collection refresh FRESH (cohort 04:10Z/179 rows, overlap 04:25Z, jobs 55/56… rpc-ccm-step1/step2 both active) — clean.

Trust: **3 breaches, ALL known** — `panini_sale_price_capture_dry_days` 14 (operator home-box runner outage), `unmapped_resolution_backlog_max` 215 (AllDay backfill inflow, outflow 967/24h ≫ live inflow 3/24h → actionable draining), `public_board_slow_count` 17 (saturation collateral + frozen by the failed 12:58Z precompute — see Candidate 1, NOT a separate finding).

---

## Candidate 1 — [MEDIUM] D34 precompute split (jobid 287) FAILED its 12:58Z tick after a full 600s — per-leg isolation did not hold under saturation

- **Source:** `check_pgcron_recent_failures()` → `rpc-trust-health-precompute-refresh` latest_status=failed, last_run 12:58Z. Drilled `cron.job_run_details` for jobid 287:
  - **12:58Z FAILED, ran 600.019 s** then `ERROR: canceling statement due to statement timeout` on an FMV-coverage leg query (`SELECT count(*)::numeric FROM editions e JOIN sales s ON s.edition_id=e.id WHERE e.coll…`).
  - **06:58Z SUCCEEDED, 233.3 s** (the tick the 08-11 overnight cited as "split confirmed").
  - **00:58Z FAILED** — the known pre-M3b `permission denied for procedure` run (M3b grant landed 01:03Z; already dispositioned, ignore).
- **Why this matters / what it contradicts:** the whole point of the 08-10 D34 split (`rpc_trust_health_precompute_refresh_p()` = INVOKER proc that COMMITs between 8 per-leg SECDEF `rpc_thp_leg_*()` functions, each with its own `statement_timeout` + `EXCEPTION→999`) was that "a saturated-tick kill now loses ONE leg (a loud 999), never the whole board." The 12:58Z run instead consumed the **full 600 s outer budget and failed as a whole job** — so a per-leg budget is NOT firing below the 600 s outer statement_timeout, OR the leg's `EXCEPTION→999` handler is not catching the cancel. The single 06:58Z success was necessary but not sufficient evidence that the split is safe; the 12:58Z failure is the first natural-cadence saturation test and it regressed to the pre-split failure mode.
- **Blast radius:** LOW/contained right now, but real. Precompute is one cycle stale — `trust_precompute_max_age_hours` 8.12 (breach 13), so still under-breach; next scheduled tick 18:58Z. Downstream symptom: `public_board_slow_count` is frozen at **17** (the 06:28Z board-liveness sweep landed in a heavy-IO window and measured 17 boards over-cap; all returned rows, all 5 public-board snapshots fresh → no user impact) and cannot re-measure down until a precompute succeeds. So the board reads 17 red arms that a healthy precompute would clear — the "stale precompute presents as N unrelated red arms" class from the 08-08/08-10 register. If two consecutive ticks fail (12:58Z + 18:58Z), max-age approaches the 13 h breach.
- **Likely cause to check (night pass / CC — D34 is CC-owned, this is the post-ship watch the 08-11 overnight "left for the automated cadence"):**
  1. Confirm the failing leg is one of the FMV-coverage legs (Legs 2–5, `editions JOIN sales`) and read its `SET statement_timeout` — the M3a widening explicitly covered only the `impossible_parallel` leg (300→480 s). If an FMV-coverage leg has no per-leg budget (or ≥600 s), the **outer 600 s `cron_heavy` role/session statement_timeout fires first** and there is no per-leg cap to catch, so the leg's `EXCEPTION` handler never gets a chance to write 999 → whole `CALL` fails. Fix = give each FMV-coverage leg a budget < 600 s (above its *saturated* cost per the M3a lesson), or lower legs' individual budgets so the outer never fires first.
  2. Verify the `EXCEPTION WHEN OTHERS → 999` block actually wraps the timed-out statement in that leg (a cancel raised *between* the SET and the wrapped body, or during the inter-leg `COMMIT`, would escape it).
- **Suggested action:** night pass — re-read jobid 287's next tick(s) (18:58Z, 00:58Z) to see if it fails only under saturation; if so, apply the per-leg budget fix from (1). Read-only monitor took no action. NOT a revert candidate — the split is still the right design; it needs the FMV-coverage legs' budgets set below the outer 600 s.

---

## NOT findings / already-logged (dispositioned this run)

- **`allday-pack-opens-backfill` + `topshot-pack-opens-history-backfill` stalled ~12h** (last runs 02:46Z / 03:11Z; `detect_stalled_pipelines()` 740/715 min). ALREADY the 0610Z monitor's Candidate 1 (spork-routed walks stalled since ~03:00Z). **Persisted and worsened** (3.3h → ~12h with no self-resolve), which strengthens that candidate's "not a transient blip → spork-proxy/mainnet24 reachability or edge-fn boot" read. Not re-filed — same open item, escalating.
- **`allday_pack_opens_forward` cursor_stalled ~12h (severity high).** Distinct from the backfill stall above. Its owner worker `pack-events-ingest` is HEALTHY (every ~15 min, ok, overall cursor advancing 161026450→161031774 in the last 75 min, rows written each tick). So this is the AllDay pack-OPENS forward sub-cursor legitimately not advancing on zero volume (AllDay is historical-only for packs; no AllDay pack-open events to find). Low-signal cursor_stalled false positive. If the night pass wants to silence it, a `pipeline_alert_suppression` row (like the two backfill canaries already carry) is the fix. LOW.
- **pg_cron MV-refresh saturation cluster** — `rpc-refresh-allday-pack-realized` (3/4 fail, 12:35Z), `rpc-refresh-misattrib-candidates` (08-10 15:35Z), `rpc-thin-sale-ask-disclosure-refresh` (09:25Z), `rpc-refresh-new-collectors` (job startup timeout, 09:45Z): standing disk-IO-saturation MV cluster, already queued (`2026-08-08T1717Z*`/`1945Z*`), self-retrying. No new lever.
- **Failure-rate alerts** — `sync-nba-projections` (all_upstreams_failed, NBA offseason + Akamai-blocked), `topshot-active-listings-ingest` (egress_blocked, atlas-proxy inert), `wallet-username-resolver` / `allday-buyer-backfill` / `allday-unmapped-resolver-tail` (statement timeout under saturation), `wallet-backfill-*` fails: documented infra-gated / saturation classes, no new code lever.
- **ipfs-media 5xx elevated (103/6h)** — already queued by the 08-11 overnight pass; not re-raised.

## Not deep-validated this run
- **Artifacts:** 11 enumerated via `list_artifacts` (candy-chain-two-onboarding-v2, rpc-panini-squeeze-v2, rpc-set-challenge-roi, rpc-pack-lifecycle, rpc-rewards-console, rpc-tracked-fmv-confidence, rpc-qa-scorecard, rpc-traction, rpc-deploys-and-cost, rpc-my-wallet, rpc-live-health), estate structurally unchanged. Payload queries NOT deep-run (shell down; following the standing precedent of not piling heavy read load on a saturation-prone pooler while the precompute/MV cluster is already timing out). Trevor's `candy_pack_ev_model` change today was a CREATE-OR-REPLACE-VIEW output-identical fix, no schema break. Night pass should re-validate when DB/shell recover.

---

## ⛔ CORRECTION 2026-08-11 (Claude Code) — Candidate 1's prescribed fix is based on a misreading

Candidate 1 concludes the 12:58Z failure means "per-leg isolation did not hold" and prescribes
"set the FMV-coverage legs' budgets below the outer 600 s." **Every per-leg budget is ALREADY below
600 s** (measured live): panini 60 · pinnacle_fmv_share 90 · pack_ev 120 · fmv_sanity 180 ·
serial_supply 180 · fmv_coverage 240 · board_liveness 300 · impossible_parallel 480. Acting on the
prescription would change nothing.

**The real mechanism:** `cron_heavy` carries a role-level `statement_timeout=600s`, and the job is a
single `CALL`. `statement_timeout` is armed once at top-level statement start and **does not re-arm
per `COMMIT`** (already durable in CLAUDE.md), so the 600 s bounds the **TOTAL** of all eight legs,
not any one of them. At 12:58Z the sum exceeded 600 s under disk-IO saturation and the `CALL` was
killed mid-run.

**The split still did its job.** Because the orchestrator `COMMIT`s between legs, the legs that had
already finished were durably written; only the tail legs (`board_liveness`, `impossible_parallel` —
the two most expensive, and last in the cheapest-first order) were lost. That is precisely the
`public_board_slow_count` freeze the 15:12Z and 18:09Z runs reported as a separate symptom. It is
**not** a failure of per-leg isolation.

**Not a live defect right now, so nothing was changed.** Subsequent ticks: 18:58Z succeeded (494.7 s)
and 00:58Z succeeded (**73.6 s**); `trust_precompute_max_age_hours` 2.23, healthy. The genuine lever,
if it recurs, is to give the two expensive tail legs their own `CALL` budget — split the orchestrator
across two pg_cron jobs — **not** to lower per-leg budgets and not to raise `cron_heavy`'s role-level
timeout (which would widen the window for every `cron_heavy` job under the same saturation).
