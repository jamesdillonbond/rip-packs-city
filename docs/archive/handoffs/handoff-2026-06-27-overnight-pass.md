# RPC nightly autonomous pass — handoff 2026-06-27 (MONITOR-MODE, off-hours)

**Mode: MONITOR-MODE.** The run fired late at real **~07:52 PDT (14:52Z)** — outside the 00:00–06:00 quiet-hours window (app-launch trigger). **No clock skew this run:** shell `date -u` 14:52Z == DB `now()` 14:52Z == app-stamped `sales.ingested_at` 14:52Z / `fmv.computed_at` 14:48Z (production rows can't be future-stamped), so the late-fire is real time, not a skewed sandbox clock. Per the quiet-hours guard → MONITOR-MODE: full review + Section 2 health triage + post-ship watch, **queue everything I'd otherwise ship, commit only docs.** Push WAS available (so this is a deliberate monitor-mode hold, not NO-PUSH). No `docs/FREEZE.md`.

Lock: prior lock RELEASED 2026-06-26T19:08Z (~19h old) → took over (runid `20260627-1452-30181`). Sandbox clone `$HOME/rpcwork`, branch `main`. origin/main **`4ecd209`** at start (advanced from last night's `48bee260` via the daytime CC + monitor wave) — unchanged through the run. Drained **3** inbox files (`2026-06-27T00-19Z`, `T03-14Z`, `T06-06Z`).

**Outcome:** shipped **0** (correct for monitor-mode), auto-reverted **0** (no regression found), repaired **0** (no artifact broken). Post-ship watch on the heavy 06-26→27 CC + overnight wave: **ALL PASS, 0 reverts.** A quiet, honest, GREEN night.

---

## Section 2 — health triage (baseline `rpc_ops_snapshot()` @14:55Z + drill-downs)

- **Security 0/0/0/0** — `invariants` [], `anon_write_holes` [], `rls_off_base_tables` [], `secdef_anon_violations` [] (all clean via the snapshot's security block; equivalent to the two catalog SQL checks).
- **`detect_stalled_pipelines()` = 1** — `allday-fmv-populate` (silent 973 min). **Confirmed-benign no-op** (the inbox ALLDAY-FMV-POPULATE-NOOP-STALL): the superseded AllDay FMV writer, WAF-403-blocked, last fired 06-26 22:42Z; AllDay FMV is **fresh** via `fmv-recalc 1.7.0` (H+M 905). Not an outage. (Queued: remove its watchlist row — see below.)
- **`check_pgcron_recent_failures()` = []** (per the STANDING focus rule).
- **`get_pipeline_alerts()` = 2** — 1 medium (`allday-fmv-populate`, the same benign no-op) + 1 INFO (`ufc_sales` resolving_editions, 1/24h, benign/long-standing).
- **Trust health 8/9 ok, 1 BREACH** — `unmapped_resolution_backlog_max` **484** /100. **OWNED / Declined** (HISTORY-BACKFILL-UNMAPPED-SPIKE): `topshot-flowty-unmapped-drain` is the fix and is healthy + watchlisted; backlog has plateaued (~413→428→441→484 over the day, producer inflow ≈ drain rate). Per the Declined rule, do NOT re-flag/skip/retire/raise-threshold; cadence is the only lever. The other 8 metrics ok (edition_integrity 4, fmv_sanity 0, offer_gap $5, pack_ev stale 0.48d, pinnacle_fmv 4.8h, ts_uuid_dupes_24h 0).
- **Pipeline fails 24h = 6**, all transient — `pinnacle-nft-resolver` 2, `check-alerts` 1, `compute-topshot-pack-ev` 1, `topshot-buyer-backfill` 1, `wmc-fmv-populate` 1. **Every one's LATEST run is `ok=true`** (recovered; verified directly). 0 logic failures.
- **Editions FLAT** — TS 17,471 / AllDay 6,191 / Golazos 581 / UFC 518 (== last night). No writer leak.
- **Sentinel TS-UUID-editions-48h = 34** (inert, far below WARN 250).
- **FMV improving** — TS HIGH 1,296 + MED 3,298 = **H+M 4,594** (4,561 baseline → 4,579 @06:06Z → 4,594 now); AllDay H+M 905 (flat/fresh); `fmv_sanity_flags` 0.
- **DB 6,282 MB** (+36 vs 6,246 @06:06Z; +106 vs 6,176 baseline = deep-history backfill wave, benign — watch the rate).

### Overnight deltas vs `metrics-latest.json` (2026-06-26T19:05Z baseline)
| metric | baseline | now | note |
|---|---|---|---|
| TS FMV H+M | 4,561 | **4,594** | improving |
| AllDay FMV H+M | 908 | 905 | flat/fresh |
| editions TS/AD/GZ/UFC | 17,471/6,191/581/518 | same | FLAT |
| sentinel ts-uuid 48h | 34 | 34 | inert |
| unmapped backlog max | 413 | **484** | owned/Declined, plateaued |
| ts-wmc-uuid fossils | ~1,753 | 1,748 | drifting down (post-211-remap), no leak |
| DB size | 6,176 MB | 6,282 MB | backfill wave, benign |
| security | 0/0/0/0 | 0/0/0/0 | clean |

---

## Post-ship regression watch — ALL PASS, 0 reverts

The 06-26→27 daytime CC + monitor wave (`48bee26`→`4ecd209`, ~25 commits) was largely post-ship-watched by the three overnight monitor ticks (00:19Z/03:14Z/06:06Z, all ALL PASS). I re-verified current health (GREEN, above) and independently checked the GHA-side / new-pipeline items the monitor could only indirect-verify:

- **`e56e4e3` AllDay per-moment badges (`allday-badge-ingest`)** — 2 runs, **both `ok=true`** (02:33Z, 22:24Z), 0 errors. Healthy.
- **`fe8fd84`/`e137570`/`182b0d1` data-integrity health_check 504 fix + `1cc9d42` ops-monitor stale-fmv 504 fix** — GHA/route, not `pipeline_runs`-tracked (as monitor noted). Indirect PASS: 0 new Sentry, security 0/0/0/0, prod READY. (Runtime-error aggregate shows only a tiny multi-route timeout cluster, count 7 over 80 days — not data-integrity-attributable post-fix.)
- **`e75f6c3`/`40e98c3` Dune ownership Pipeline A** — `topshot_ownership` **0 rows** = INERT as designed (unprovisioned). No runtime effect. PASS.
- **`audit_20260627_remap_ts_wmc_uuid_fossils` (211 rows) + the net-zero `drain`/`revert` pair** — confirmed clean: only `audit_20260627_wmc_fossil_remap` survives (RLS-on); the drain + revert audit tables were dropped (net-zero). Editions FLAT, security 0/0/0/0, fossils 1,748 (drifting down). PASS.
- **`9fc5851` Rookie Board + `3f4c2c1` New Collectors public surfaces** — data-layer/security/routing fully verified by the monitor (backing views security_invoker / anon-SELECT / no address leak / sitemap / proxy bypass / OG / Vercel READY / 0 Sentry). The live-HTTP/visual leg remains (queued — see below).
- **Vercel** — prod = **`b0a6554` (dependabot build-skip) READY, 0 ERROR**. The 4 newer commits (`3c20100`/`40e98c3`/`59c21c3`/`4ecd209`) are docs/monitor-only and correctly **CANCELED** by the docs-only `ignoreCommand` git-diff gate (expected, not failures).
- **Sentry** — 5 unresolved, all **stale transient flakes** (4 smoke-test one-offs: pack-listings / disney-pinnacle-overview / golazos-analytics / RLS-leg; + 1 Next.js router-state-parse), each 1–6 events, last seen 1–6 days ago, **0 new in 24h, 0 attributable** to the wave. The RLS smoke flake (NEXTJS-1C, last 2d ago) is contradicted by live security 0/0/0/0.
- **Runtime errors (11 groups, 24h)** — all long-standing benign/perf: the `url.parse` DEP0169 **warning** (807, not an error), idempotent `wmc_wallet_moment_unique_idx` dup-key upsert races (since May), heavy-page statement timeouts (team/pack/fmv-recalc, pre-existing), the `allday-fmv-populate` 403 (stopped 22:42Z = the no-op stall), OG IPFS-image fallback. No new error class.

---

## Shipped this run

**None** — correct for MONITOR-MODE. Nothing both warranted and monitor-mode-permitted. (The one clean DB-only item, removing the `allday-fmv-populate` no-op watchlist row, is queued below with ready SQL.)

## Auto-reverted / Failed / Blocked

**None.** No regression found in the post-ship watch; no verification failures; no hard-stop.

---

## Queued

### NEW this run (from the drained inbox)

1. **ALLDAY-FMV-POPULATE-NOOP-STALL — remove the benign no-op's watchlist row (LOW · DB-only, ship next genuine overnight or operator).** `allday-fmv-populate` is the permanently-superseded AllDay FMV writer (WAF-403, writes 0 rows/tick; AllDay FMV owned by `fmv-recalc 1.7.0`). It is now a standing false-positive in BOTH `detect_stalled_pipelines()` and `get_pipeline_alerts()` (medium) — monitor noise that degrades the silent-stall signal. Would have shipped tonight if in-window; held per monitor-mode. **Ready SQL:** `DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline='allday-fmv-populate';` **Revert:** `INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, is_active) VALUES ('allday-fmv-populate',120,'medium',true) ON CONFLICT (pipeline) DO NOTHING;` **Verify after:** `detect_stalled_pipelines()` no longer lists it AND AllDay FMV stays fresh via fmv-recalc. (Operator follow-up: also retire the cron-job.org "allday-fmv-populate" entry.) Night-count 1.

2. **NEW-COLLECTORS-INSIGHTS-QA — live-HTTP/visual close (LOW · interactive).** `/insights/new-collectors` (`3f4c2c1`). Data-layer/security/routing/sitemap/OG fully verified (monitor + me). Only the live-HTTP-200 + drill-down/brand visual leg remains, which is **automation-blocked this run** (`web_fetch` is provenance-gated; not reaching for curl/Chrome alternatives in an unattended monitor-mode run for a LOW item). Best closed in an interactive `rpc-insights-qa` session. Night-count 1.

3. **ROOKIE-BOARD-INSIGHTS-QA — live-HTTP/visual close (LOW · interactive).** `/insights/rookie-board` (`9fc5851`). Same status as #2: data-layer/security verified (431 rows / 61 players / 227 `::` rows / 401 with FMV, no address leak, has_full_economics honesty contract present); only live-HTTP/visual remains, automation-blocked. Night-count 1.

### RESOLVED / CLOSED this run (reconciliations, no DB change)

- **DRAIN-WATCHLIST — RESOLVED.** Shipped by CC today (`89992e6`): `topshot-flowty-unmapped-drain` is now in `pipeline_cadence_watchlist` (90m/medium/active); `detect_stalled` does not flag it. The night-pass-queued item is done — remove from queue.
- **BUYERBF-PERINVOCATION-WORK — RESOLVED** (CC 06-27 reconciliation): clean 2×/hr cadence, 158–278s/run, no overlap, nowhere near the 800s cap. Remove from queue.
- **UFC-EDITIONS-SEED-GAP — RESOLVED** (CC 06-27): 0 missing (all 518 UFC wmc keys match an `editions` row). Remove from queue.
- **PINNACLE-EDITION-KEY-UUID-CAST — CLOSED (addressed by CC `43769cc`).** The Pinnacle render_id re-key + `permanentRedirect` from `/disney-pinnacle/edition/<slug>` → `/pinnacle/moment/<slug>` removes the uuid-cast throw path (edition pages now redirect). Deploy READY; post-ship-watched PASS; editions FLAT; pinnacle trust metrics ok. Close.

### CARRIED (one-liners)

- **HISTORY-BACKFILL-UNMAPPED-SPIKE / unmapped backlog 484** — owned/Declined; drain is the fix; plateaued; do NOT re-flag (night-count: standing).
- **TS-WMC-UUID-FOSSILS (1,748 tail)** — Trevor decision: deployed on-chain re-resolution route vs. accept as permanent inert residual; do NOT autonomously delete (the 06-27 session-2 blind-drain collided with the recorded hands-off decision and was reverted).
- **ALLDAY-V1-UNMAPPED-DRIFT (475 open; 441 edition-resolution class)** — Trevor decision: accept residual / build on-chain edition-resolution / pace the V1-history backfill.
- **WEEKLY-SURFACE-QA-PROSE** — rpc-live-health 2 stale prose strings (LOW/cosmetic; full-file reinstall risk; pair with the new-collectors/rookie-board insights_counts adjunct).
- **topshot-sales-history-backfill watchlist** (LOW, older GHA edition-queue backfill, future night).
- Long-standing: THIN-FMV-GUARD-CONTENTION, refresh-conflated-editions cron (operator), VERCEL cost family, A1-WORKER-PASSTHROUGH-CLEANUP, PIN-FMV-REKEY-WAVES 2/3, PIN-SYNC-CRON, P3-BUYERS, DUPE1, Q2/Q5/Q6, N1, ANALYTICS-SMOKE-RESIDUAL, IPFS ×2.

### STEER honored (do NOT re-flag)
SERIAL-FMV-MULT-CRON (weekly by design), evm-transfers Base-429 (benign), allday-listing-serial-backfill 1009 WAF (external), the unmapped backlog BREACH (owned/Declined/draining).
