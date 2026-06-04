# RPC nightly autonomous pass — 2026-06-03 (overnight)

**Mode:** GENUINE OVERNIGHT (local 01:03 PDT, inside the 00:00–06:00 window) + **NO-PUSH** (the scheduled sandbox has no GitHub push credentials and the `rip-packs-city-bot` clone is not mounted — only the shared `rip-packs-city` working tree is). DB migrations (Supabase connector) and artifact checks apply normally; all repo outputs (this handoff, ledger, metrics, inbox archive, CLAUDE.md note) are **written to disk uncommitted** and will be picked up by a future run / Trevor's machine. No code commit or Vercel deploy this run (none were needed).

**Run:** runid 162314944. Lock: prior `.lock` was an ~18h-stale RELEASED marker → took over (sandbox can't `unlink`, so re-marked ACTIVE then RELEASED at end). No `FREEZE`. On `main`. Baseline metrics: `docs/overnight/metrics-latest.json` @ 2026-06-02 13:42Z.

**Verdict: ✓ GREEN — quiet honest night.** Shipped **1** production-affecting change (a 2-row monitoring-config migration that clears the `detect_stalled_pipelines()` false-positives), independently subagent-verified PASS. Reconciled **3** ledger items (P1, S1, N1) that were already resolved on the live DB but still showed queued. Nothing failed, nothing auto-reverted, platform health flat-to-improving.

---

## 1. Reviewed

- **CLAUDE.md** (full), **ledger** (full, incl. empty Declined section), **4 daytime-monitor inbox files** (2026-06-02T15:14Z, 2026-06-03T01:49Z, 05:30Z, 06:21Z), the two newest handoffs (`stop-flow-drain-and-monitor-noise`, `fmv-sweep-drafts`), `metrics-latest.json`. No `focus.md`.
- **Inbox candidates drained:** L1 (league-drift cron-wiring), A1 (gas-wallet drain — self-recovered), PIN1 (NEXTJS-15 gate tuning), C-PAYER (deactivate paused payer watchlist row), C-PIN (pinnacle-metadata-backfill threshold). All 4 inbox files archived to `inbox/archive/`.
- **Artifacts:** 12/12 present and (per the 06:21Z monitor + no schema break tonight) healthy. None flagged broken in any inbox; **none repaired** (don't regenerate working artifacts).
- **Collision gate:** `origin/main` = `d8cc6c2` at run start AND at ship time (no human/CC push mid-run). No committed change to any watchlist/cadence file in 48h. The migration touches only DB config rows (no file edit), so no hot-file concern.

## 2. Health-drift findings + deltas

**Post-ship regression watch (done FIRST) — GREEN, no auto-revert.** Recent ships in the last 24–48h are all Trevor/Claude-Code (the night pass shipped nothing 06-01/06-02). Re-measured the riskiest — the 2026-06-03 interactive FMV sweep (`audit_20260603_*` migrations confirmed live: F2 Tier-A 8:62→Clamps re-map @05:34Z, F4 wallet-stats split-STALE, v_fmv_sanity_flags v2) plus the `6e90f3f` D2 JSON-LD STALE gate and `d8cc6c2` storefront-cleanup removal:
- **FMV fresh + healthy:** TS latest snapshot 08:08:29Z (~1m), AllDay 08:08:14Z (~1.6m), Golazos/UFC ~9m. fmv-recalc writing 6,656 TS + 2,298 AllDay rows in 2h. No throughput regression from the F3/F5 fmv-recalc edits.
- **F2 destructive 8:62 re-map landed correctly:** Clamps `226:7541` now holds its 22 sales (0 impossible-serial sales, FMV LOW $1.33 — sane). Cosmic `8:62` retains its 65 documented Tier-B impossible-serial sales, correctly **excluded from WAP by the F3 guard** (this is the ledger-documented open Tier-B, not a new regression).
  - **Eyeball-note for Trevor (low priority, NOT a regression):** `8:62` Giannis Cosmic (circ 49) resolves to FMV **HIGH $2.43** off its 14 remaining serial≤49 sales — that reads low for a circ-49 Cosmic. The F3 guard is doing its job (the 65 impossible sales are out), but it's worth confirming those 14 are genuinely this edition's sales as part of the open F1/F2 Tier-B cleanup.
- Daytime monitor swept 4× today; every sweep reported green / no recent-ship regression / FMV improving.

**Pipelines (24h):** all `ok=false` rows are the known transient cron-rush class (connection-pool / statement / upstream timeouts at the 00:00/06:00/12:00Z rushes), all self-recovering, none logic faults, none deploy-attributable. N2 (`topshot-moments-hydrator` candidate-read statement timeout) recurred once at 06:02:04Z exactly as expected (queued; do-NOT-revert the materialized-CTE fix). `cadence-payer-balance-check` 12 fails were the dry-wallet alarms 20:30Z–01:30Z (topped up; ok=true 02:00–05:00Z; then cron paused → the C-PAYER situation).

**`detect_stalled_pipelines()`:** at run start = 1 entry (`cadence-payer-balance-check`, high, 186m/60m, by-design-paused). **After tonight's ship = `[]`.**

**Security:** 0 RLS-off base tables; 0 anon/auth write-grants on RLS-off base tables (the catalog query in the task prompt omits `relkind IN ('r','p')` and false-positives on 47 views — applied the documented `relkind` filter → 0). anon-readable-non-`security_invoker` views back to **0** (S1 resolved). 

**Sentry:** 1 unresolved = `JAVASCRIPT-NEXTJS-15` (PIN1 — Pinnacle listing-indexer `cadence_capped` gate noise, 3 events, last seen ~05:00Z, not spiking, no user-facing break). `NEXTJS-1F` aged out of the unresolved set.

**Vercel:** 14/14 recent prod deploys READY, 0 ERROR. Current prod `dpl_625XNZjmXoNmdsruUTtrGuye113A` (`d8cc6c2`) READY.

**Overnight deltas (vs 06-02 13:42Z baseline):**
| metric | baseline | tonight | note |
|---|---|---|---|
| FMV TS HIGH+MED | 933 | 932 | flat |
| FMV TS NO_DATA | 4634 | 4424 | ↓ improving |
| FMV AllDay HIGH+MED | 274 | 273 | flat |
| editions TS | 16334 | 16344 | +10 normal |
| sentinel TS-UUID-48h | 45 | 43 | flat, <250 ok |
| unmapped_sales total | 271 | 278 | +7 normal |
| DB size | 5966 MB | 5999 MB | +33 normal |
| security base-tables | 0/0 | 0/0 | clean |
| detect_stalled | 1 (N1) | 0 | cleared |

## 3. SHIPPED (1 change — within the 4/night cap)

### `audit_20260603_watchlist_destall_paused_payer_and_hourly_pinnacle` (DB, monitoring-config; applied via Supabase connector — unaffected by NO-PUSH)
Two `pipeline_cadence_watchlist` row UPDATEs that stop `detect_stalled_pipelines()` crying wolf (the exact "don't train us to ignore the deterministic stall check" class as P1/Q9/Q10):

- **C-PAYER** — `cadence-payer-balance-check` → `is_active=false`. Its cron-job.org entry was intentionally PAUSED 2026-06-03 (`d8cc6c2` removed the storefront-cleanup FLOW drain; payer wallet `0x73f55c4450b8d466` is intentionally dormant — N3 / known-issue #9). The still-active 60m row was emitting a permanent **HIGH-severity** false-positive every sweep (186m+ and growing). Last actual run 05:00:41Z was `ok=true` → the silence is the deliberate pause, not a failure.
- **C-PIN** — `pinnacle-metadata-backfill` → `max_silent_minutes` 90 → **200**. Healthy hourly :22 pipeline (every run `ok=true`) whose external cron drops ticks — on 2026-06-03 it skipped 00:22Z, then **05:22Z AND 06:22Z consecutively** (04:22→07:22 = 180m gap), tripping the 90m threshold. 200m tolerates up to two consecutive skipped ticks (≤180m) while still surfacing a genuine 3+-hour dead-cron (≥240m). (Chose 200m over the monitor's suggested 150m because the live data showed a *double* skip; 150m would have re-tripped.)

**Verification:** independent fresh subagent (no prior context) ran 5 read-only checks → **PASS**: rows have the intended values (`cadence-payer-balance-check` is_active=false; `pinnacle-metadata-backfill` 200m); `detect_stalled_pipelines()` = `[]`; cadence-payer latest run `ok=true` (deliberate pause, not a crash); pinnacle-metadata-backfill most recent run 07:22:09Z `ok=true`, all 12h `ok=true` (healthy, no masked outage); `pg_tables rowsecurity=false` = 0 rows (no RLS regression).

**Revert** (single migration, two independent UPDATEs):
```sql
-- C-PAYER revert:
UPDATE public.pipeline_cadence_watchlist
SET is_active = true, max_silent_minutes = 60,
    notes = 'Health check for the Cadence service payer wallet 0x73f55c4450b8d466. Schedule cron-job.org every 30min. ok=false fires when balance < 0.05 FLOW. 2026-05-17: 649 INSUFFICIENT_GAS_FUNDS errors traced to this payer being drained; this check surfaces the depletion at the source rather than downstream where every signing pipeline produces a follow-on error. Top up via flow CLI or directly to 0x73f55c4450b8d466.'
WHERE pipeline = 'cadence-payer-balance-check';
-- C-PIN revert:
UPDATE public.pipeline_cadence_watchlist
SET max_silent_minutes = 90,
    notes = 'Hourly :22. Cadence-only (no GQL). Three queues: mint_count cap 100, edition_key cap 50, disagreement cap 25. Soft-deadline 25s. 90min silence threshold = hourly + 30min grace.'
WHERE pipeline = 'pinnacle-metadata-backfill';
```
**Target metric to re-check next run:** `detect_stalled_pipelines()` does not list `cadence-payer-balance-check` or `pinnacle-metadata-backfill` (should stay `[]` absent a genuine new stall). If `pinnacle-metadata-backfill` re-appears, its external cron is dropping ≥3 consecutive ticks → operator look at the cron-job.org entry (framing b).

## 4. Reconciled — already resolved on the live DB (verified, not re-shipped)

The ledger/metrics still listed these as queued, but live verification shows they landed 2026-06-02 ~15:01Z (after the 06-02 night pass captured its baseline at 13:42Z). Marked resolved in the ledger:
- **P1** (raise `evm-transfers-ingest` watchlist 60→150m) — live via migration `audit_20260602_evm_transfers_watchlist_threshold_150m`; the row is at 150m with the exact P1 note. Not in `detect_stalled` this run.
- **S1** (close anon-readable SECDEF view `v_moments_needing_hydration`) — live via migration `audit_20260602_revoke_anon_v_moments_needing_hydration`; anon-readable-non-invoker-views back to 0.
- **N1** (`snapshot-institutional-wallets` stall) — self-recovered; not in `detect_stalled` (one transient 06:00Z upstream-reset fail today, otherwise running).

## 5. QUEUED (operator / Claude Code — not auto-shippable this run)

- **N2** (operator/CC, night 2) — `topshot-moments-hydrator` candidate-read (`v_moments_needing_hydration`) statement-times-out at the 00:00/06:00/12:00Z cron rushes (recurred 06:02Z today; 3/138-class, self-recovering, no backlog). Do **NOT** revert the materialized-CTE fix (net-positive). Deeper fix: bump candidate-read `statement_timeout`, add a supporting index for the anti-join predicate, or further reduce view cost. (The earlier "fold S1 `security_invoker` into the same CREATE OR REPLACE" bundling note is now moot — S1 was resolved via REVOKE.)
- **N3** (operator) — payer wallet `0x73f55c4450b8d466` funding/alerting decision. **C-PAYER shipped the monitoring-noise slice tonight** (deactivated the watchlist row); the wallet-funding + cron-revival decision stays operator-owned. Re-activate the watchlist row (revert above) + fund the wallet if/when reviving Cart / Trade-Hub / breaks.
- **L1** (operator/CC, NEW) — `league-drift-detection` has run exactly once (2026-05-31 14:00Z); not in `pipeline_cadence_watchlist`. Confirm intent: if recurring, wire a cron + add a generous watchlist row; if one-shot, record in `cron-schedule.md`. (Not auto-shippable: needs intent confirmation, and watchlisting a possibly-deliberate one-shot would itself false-positive.)
- **PIN1** (operator/CC, NEW) — `NEXTJS-15`: the pinnacle-listings-indexer Sentry spike gate counts `cadence_capped` *deferrals* (self-draining backpressure) toward `SENTRY_SPIKE_THRESHOLD`, so a transient inflow burst trips a warning. Fix in `app/api/pinnacle-listings-indexer/route.ts`: exclude `cadence_capped` from the spike count (count only terminal `edition_key_unmapped`), or raise the per-tick cadence budget. Touches route capture logic → not night-pass auto-shippable.
- **Q2** (operator, watch) — `compute-laliga-pack-ev` cadence (by-design Golazos; appears active).
- **Q5** (operator/CC) — smoke sales-lag threshold rebase to last-successful-run.
- **Q6** (low) — `evm-transfers-ingest` Base-429 backoff (ingest getLogs 10k→5k + retry shipped `8605c43`; the watchlist piece was P1, now done).
- **Q7** (INFRA, Trevor) — scheduled sandbox has no push creds and does NOT mount the `rip-packs-city-bot` clone → night pass stays DB-migration + artifact + on-disk-docs only. Confirmed again this run. (Trevor's machine/CC pushes fine via the bot-clone identity — all 14 recent deploys are authored `rpc-daytime-monitor`.)
- **Q8** (operator/CC) — badge-sync `onConflict:id` vs `UNIQUE(external_id,collection_id)` row-grain (moot for offers via `edition_offers`).
- **F1 / F2-TierB** (operator/CC) — the broader serial>circ mis-key batch + the 65 residual Cosmic `8:62` Tier-B sales (need on-chain V1/V2 Dapper confirmation before moving; F3 guard protects WAP meanwhile). See the `8:62` eyeball-note in §2.

## 6. Failed / auto-reverted

None. No verification failure; no production shipping hard-stop triggered.
