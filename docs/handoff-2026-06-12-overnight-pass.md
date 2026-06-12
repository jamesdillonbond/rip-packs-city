# Overnight pass handoff — 2026-06-12 (MONITOR-MODE, off-hours 06:49 PDT / 13:49Z)

Run fired ~06:49 PDT (outside the 00:00–06:00 window) → MONITOR-MODE: full review + health triage + post-ship watch, **nothing shipped** (queue-only per the off-hours rule). Push WAS available (clone flow worked end-to-end again — Q7 re-confirmed resolved); only docs committed. Lock taken over from the RELEASED 06-11 marker; runid=125627929.

**The run landed in the middle of an ACTIVE INCIDENT — see Section 1. This handoff doubles as the incident record.**

---

## 1. INCIDENT — DBSAT-IO-EXHAUSTION-0612 (HIGH, operator): severe disk-IO starvation from ~07:00Z, total telemetry blackout from ~12:45Z, user-facing page errors, FMV writers down

**Status at time of writing (14:25Z): ONGOING.** (Final pre-commit check 14:35Z: DB connections still timing out at the connector level — no recovery yet.) Zero `pipeline_runs` rows logged 13:39→14:13Z+ (only 1 row 13:02→14:13Z). Repeated MCP/PostgREST connection timeouts during this run's own queries.

### Timeline (all 06-12 UTC)
- 00:19Z — `topshot-listing-cache` logs its last run (separate finding, §3.4 — silent BEFORE the window).
- 01:15Z — `topshot-fmv-populate` ok (the TFP verdict-green tick).
- 04:28Z — **last `fmv-recalc` ok**. 7 consecutive saturation-class fails after (04:48→12:48Z: `edition_page_fetch` statement/upstream timeouts, one step3 lock timeout).
- ~07:00Z — degradation onset: 07Z hour run-count collapses to 86 (normal ~200) with 26 fails. Same onset hour as 06-11's window.
- 08–11Z — partial function: ~200 runs/hr, elevated fails 9–21/hr.
- ~12:05Z — the 12Z seed-refresh wallet-backfill wave starts and immediately grinds: backfills that normally take minutes run 33–57 min (durations 2.0–3.46M ms on the rows that completed 12:56–13:02Z).
- 12:39Z — tshb GHA schedule fire (full-meal config) lands on top of the grinding wave.
- ~12:43–13:02Z — **every pipeline's last logged run** falls in this window. After 13:02Z: one `promote_unmapped_sales` row at 13:39Z, then nothing through 14:13Z+.
- 13:50–14:20Z — this run's own evidence gathering: see below.

### Evidence (measured live this run)
- `pg_stat_activity` 14:05Z: **multiple COMMITs waiting on `LWLock:WALWrite` for 2–4+ s** (WAL flushes queueing = write IO throughput exhausted); `IO:DataFileRead` waits on reads; earlier an `autovacuum: ANALYZE wallet_moments_cache` active 8m47s.
- Postgres logs 13:53–14:00Z (7 min): **48 statement-timeout cancels**, 33 slow-query plans 11–32s. The slow plans are all wmc-path: `backfill_wmc_metadata_from_editions` 22.7s, `upsert_wmc_batch` 11.4s (normal ~0.2–1.4s), and a **plain wmc index-only scan (planner cost 313) taking 23.6s** — conclusive IO starvation, not a plan regression.
- Vercel runtime logs 13:53–13:58Z: cron requests ARE arriving and returning 200/202 (dispatch is fine — cron-job.org is NOT the problem); page reads erroring: `[edition] get_edition_detail` / `[player]` / `[set] detail error upstream request timeout` on multiple public pages; `Vercel Runtime Timeout Error` on check-alerts, pinnacle-listings-reconcile, backfill-pack-rip-metadata. **So: user-facing intermittent page degradation, confirmed.**
- Site shell healthy: `/api/health` 200 in 0.45s, `/login` 200.
- `pg_stat_statements` (cumulative): top read-IO entries are all wmc-path RPCs (top entry 202M blocks ≈ 1.5TB read, mean 11.6s over 8,035 calls). The legacy TS-leg wmc INSERT remains frozen at 37,615 calls (the 06-10 fix is still holding — this is NOT a f41caf4 regression).

### Read (attribution — measured, not guessed)
This is the **third consecutive daytime IO-exhaustion window** (06-10 10:00–15:30Z; 06-11 07:00–14:30Z peak 59% fails; 06-12 07:00Z→ongoing, now with telemetry blackout). The pattern PREDATES the tshb acceleration (06-10's window came before tshb existed) → **no auto-revert of recent ships is warranted on this evidence**. Today is materially worse than yesterday: yesterday peaked at 59% fails/hr with smoke quiet; today pipelines cannot even log, and public pages are intermittently erroring. The shape is consistent with the Supabase compute add-on's disk-IO budget depleting through the daytime write load (00Z/06Z waves + daytime traffic + the growing write workloads: buyer-backfill, tshb drains, offers raise, audit waves) and the 12Z wave then being unable to complete — a self-sustaining grind: the wave holds IO pinned, everything else starves, the wave itself takes hours.

### Recommended operator actions (in order)
1. **Confirm on the Supabase dashboard**: Database → Reports → Disk IO (budget/IOPS graphs) for 06-10→06-12. If the budget graph shows depletion through each daytime window, the diagnosis is confirmed in one look.
2. **Decide the capacity lever (billing, Trevor-only):** compute add-on upgrade (Micro → Small/Medium) buys IO budget immediately. This is the only fast structural fix if organic load keeps growing — and signups + tshb + buyer-backfill are all growth.
3. **Load-reduction levers (no billing):**
   a. Ship the **wmc fifth-call-site swap** ([docs/handoff-2026-06-10-wmc-fifth-call-site.md](handoff-2026-06-10-wmc-fifth-call-site.md)) — the TS wallet-backfill route still rewrites wmc via the legacy per-row PostgREST upsert; the TS leg is the heaviest wave component. Already specced, CC-ready.
   b. **Pace the seed-refresh waves**: the 6h orchestrator fires all seeded wallets at once (~12:05Z herd). Spreading dispatches over 30–60 min would flatten the IO spike. (Route-logic change → CC, not night-pass.)
   c. Optional immediate relief: temporarily disable the **tshb GHA schedule** (1-click on the workflow page) until the incident class is resolved — it's a pure-additive drain that can wait; the 12:39Z fire added sustained write load mid-wave. Re-enable after.
4. **After recovery, verify** (any session): fmv-recalc ok-streak resumes; analytics-smoke streak resumes; TFP ticks at 19:15Z/01:15Z; pipeline fails/hr back to ~1%; backlog drains (editions-hydrate, pack-meta).

### Explicitly NOT done this run (and why)
- No `pg_terminate_backend` on the grinding wave — the starvation is aggregate IO, not one rogue query; killing idempotent backfills wouldn't restore the budget and risks partial-wave state.
- No threshold tuning, no migrations — off-hours monitor-mode + an unstable DB is the wrong moment to write monitoring config.

---

## 2. Post-ship regression watch (last 24–48h ships)

| Ship | Verdict | Evidence |
|---|---|---|
| 06-11 night-pass: analytics liquidity LATERAL + 110s stopgap | **PASS** | analytics-smoke logged a **14-consecutive-ok streak** 21:13→02:43Z (monitor-verified). Today's smoke silence is the incident, not the fix. |
| 06-11 night-pass: buyer-backfill watchlist @90m | PASS | No false positives; buyer-backfill ok through 12:34Z. |
| 06-11 Cowork analytics optimizations (4 migrations) | PASS | data_quality ~102ms / packs_summary 68–409ms confirmed by the 18:20Z monitor; no regression attributable. |
| TFP round-cast fix (audit_20260611_fix_upsert_topshot_marketplace_fmv_round_cast) | PASS | TFP 01:15:25Z ok=true end-to-end — first ok since 06-09. (Today's 07:15/13:15Z misses are incident-window, §3.2.) |
| cd77861/18fdf7e tshb route + 1a0926e→46500e4 acceleration | PASS w/ flag | 8 GHA **schedule** runs since 06-11 14:11Z all success (TSHB-GHA-NOSCHED **RESOLVED**); UUID-leak-48h = 0 (no edition-creation leak). Flag: the 12:39Z full-meal fire landed mid-wave during the incident — see §1 mitigation (c). Not revert-worthy: pattern predates tshb. |
| d0acecf offers (per-moment best offer + edition raise) | PASS-so-far | offers-sweep ok through 12:42Z incl. the raise step; no new Sentry. New trust-health leg unverifiable this run (view timed out under incident). |
| b28a22f UFC wmc enrichment unstarve | UNVERIFIABLE this run | Needs wmc count queries — too expensive during the incident. Self-heal window is 6–24h of seed-refresh; **carry to tonight: UFC null-edition_key count should be falling from 3,150/4,584.** |
| e386542 / p25 / p26 pack-events | PASS | ok through 12:39Z, cursor advancing pre-incident. |

**Auto-reverts: none warranted.** The only regression-shaped signal (the incident) predates every candidate ship.

## 3. Health-drift triage

1. **Security: 0/0 clean.** RLS-off base tables `[]`; anon/auth write grants on RLS-off `[]`; `check_secdef_anon_execute_violations()` + `check_public_security_invariants()` clean.
2. **TFP (topshot-fmv-populate):** last ok 01:15Z; 07:15Z and ~13:15Z slots did not log — both inside the degradation window, so cause is ambiguous (starved vs dropped). **Do NOT restore the watchlist 480 yet** (it would page immediately during a known incident). Restore gate updated: **two consecutive ok ticks outside a saturation window** → `UPDATE pipeline_cadence_watchlist SET max_silent_minutes=480 WHERE pipeline='topshot-fmv-populate';`
3. **TS pricing freshness degraded ~10–14h** (combined: fmv-recalc last ok 04:28Z, TFP 01:15Z, listing-cache 00:19Z). Self-heals post-incident; verify tonight.
4. **NEW — LISTCACHE-SILENT-0612 (operator):** `topshot-listing-cache` has ZERO runs since 00:19Z — silence began ~6.5h BEFORE the 07Z window, so it is NOT explained by the incident. Same class as LISTCACHE-CRON-DROP (06-08). Check the cron-job.org entry (history / auto-disable / Inactive flag); re-fire. Note fmv-recalc's 20-min cadence is partly chained off this entry, compounding §3.3.
5. **Sentry: 6 unresolved, ZERO new in 8h.** 1E/A/E/W smoke echoes (last ~06Z), NEXTJS-1P auth-lock steal (3 ev, 14h quiet), NEXTJS-15 (1 ev, 17h). Notably the smoke cluster did NOT fire during today's blackout — the smoke route itself can't complete enough to assert.
6. **Deploys: 20/20 READY** (prod `46500e4`). DB **4,311 MB** (+19 vs 03:10Z, mild creep watch unchanged). UUID-leak-48h **0**. unmapped_sales: unmeasured this run (carry 183 flat from 03:10Z).
7. **FMV confidence counts: unmeasurable this run** (sentinel RPC + trust-health view timed out under the incident). Carry 03:10Z monitor values: TS HIGH+MED **3,226** (942 H / 2,284 M) — trend up from 3,103 baseline; AllDay 601 carry from 06-11.
8. **Artifacts: not swept this run** (17/17 enumerated green at 03:10Z; running artifact queries against a starved DB would add load and tell us nothing new). AF1 expected to error-on-open during the incident — known load-sensitivity, not a repair candidate.

## 4. Queued (new + changed)

- **DBSAT-IO-EXHAUSTION-0612 · HIGH · operator/Trevor — morning #1.** Active incident, full record §1. Actions: Supabase disk-IO graphs → compute upgrade decision → wmc fifth-call-site (CC) → wave pacing (CC) → optional tshb-schedule pause. Re-baseline DBSAT after.
- **LISTCACHE-SILENT-0612 · MED-HIGH · operator.** §3.4. Re-fire/re-enable the topshot-listing-cache cron entry; verify next tick logs.
- **TFP-480-RESTORE (amended gate) · ship-ready, night pass.** §3.2. Single UPDATE + inverse revert; gate: 2 consecutive ok ticks outside saturation.
- **UFC-WMC-NULLKEY-VERIFY · tonight.** §2 — confirm null-edition_key count falling from 3,150/4,584; if NOT falling after 24h of waves, the b28a22f self-heal premise is wrong → re-open.
- **TS-GQL-429 · watch (carried).** Re-measure 429 rate across TS-GQL pipelines now that tshb full-meal is live; if rising, pace tshb (smaller MAX_TX_PAGES or jitter), don't touch offers-sweep.
- **TSHB-GHA-NOSCHED · CLOSED.** 8 schedule-event successes since 06-11 14:11Z (GitHub API verified). Sparse ~2–5/day cadence is GitHub throttling, by-design with the full-meal config.
- Carried unchanged: ANALYTICS-SMOKE-RESIDUAL (CC), PACK-META-SILENCE (one more night; unevaluable during blackout), OFFER-SANITY-RAISE (Trevor product call), USERNAME-CRON-UNWIRED, IPFS ×2, CRON-30S 3/4, PIN-FMV-REKEY-WAVES 2/3, PACKVIZ-GRID, NEXTJS-15/Q4, P3-BUYERS, Q5/Q6/Q8, N1, SMOKE-EDITION-TIMEOUT, NEXTJS-1M/1K/1N/1P watch.

## 5. Run hygiene

- Mode: MONITOR (off-hours). Shipped 0 production changes, reverted 0, repaired 0 artifacts. Ship budget unused.
- Git: sandbox-native clone; push capability verified (--dry-run ok). Docs-only commit pushed this run. origin/main did not advance mid-run (last commit b926632 = 03:11Z monitor).
- Inbox: 5 files drained → docs/overnight/inbox/archive/ (2026-06-11T15-15Z, 18-10Z-cowork-analytics-optim, 18-20Z, 2026-06-12T01-20Z, 03-10Z).
- docs/overnight/metrics-latest.json overwritten with this run's (partial — incident-limited) values.
- Lock: marked RELEASED at run end.
