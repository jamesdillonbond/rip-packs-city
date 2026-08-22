# Daytime monitor — 2026-08-21T21:05Z (14:05 PT)

**Run posture: SEVERE saturation spell in progress. All causal claims below are SYMPTOMS deferred to a quiet-window re-measure (Section 1c). Nothing here is a cause, a cost, or a bug count.**

Positive control at 21:05Z: `pg_stat_activity` → **io_wait=34 / active=33 / total_backend=44** (majority of active sessions in IO wait). `rpc_ops_snapshot()` **timed out** (statement timeout) — itself the spell signal. Did NOT run heavy probes (detect_stalled_pipelines, artifact payloads, trust-health) — spell discipline, do not stack IO.

## What is clean (cheap catalog reads only)
- **Security 3/3 clean:** `public_rls_off=0`, `anon_write_holes=0`, `check_secdef_anon_exec_drift() len=0`.
- **Vercel healthy:** latest production **READY = `08-21 18:13Z`** (`fix(entity): stop four sections concluding "No s…"`). No ERROR-state deploys in the last 20; the CANCELED entries after it are docs-only commits skipped by `ignoreCommand`. Trevor is actively building (many Claude Code commits today).

## SYMPTOMS observed (all saturation-class — file, do not act; re-measure in a quiet window)
1. **pg_cron: 13 jobs failing, ALL saturation-class** — every message is `canceling statement due to statement timeout` or `job startup timeout`, **zero logic errors**. Per CLAUDE.md this is saturation collateral, not 13 distinct bugs. Includes `rpc-ccm-step1`/`step2` (04:10/04:25Z) — the cross-collection MV, **already tracked** (ledger 08-20 + inbox `2026-08-19T1511Z` CANDIDATE 1, now several consecutive failed cycles). Also `rpc-refresh-market-index-daily`, `rpc-refresh-allday-pack-realized`, `rpc-backfill-pinnacle-acquisitions`, `rpc-refresh-misattrib-candidates`, `rpc-refresh-new-collectors`, `rpc-refresh-challenge-costs`, `rpc-weekly-log-purges`, `rpc-refresh-players-current-team`, `rpc-thin-sale-ask-disclosure-refresh`, `rpc-allday-listing-ask-fmv`, `rpc-attribute-pack-rips-empirical`. No re-file — collateral.
2. **`fmv-recalc`** — `sales_refetch_failed: 1 chunk fetch errors (saturation-class)`. Known/tracked (wasteful-not-broken, saturation). No action.
3. **wallet-backfill family reporting `rows_lost` — the one potentially-actionable item, deferred.** Across the 21:00–21:07Z window, `wallet-backfill`, `-allday`, `-pinnacle`, `-ufc` logged repeated `wmc_upsert_chunk_failures=N rows_lost=M first="Timed out acquiring connection from connection pool."` — single-window `rows_lost` values seen include 592, 400, 200, 168, 162, 141, 94… (thousands of wmc rows in aggregate this window). Under the spell the connection pool is exhausted, so upsert chunks are being dropped.
   - **Question for a QUIET-WINDOW re-measure (do NOT conclude now):** does the cursored wallet-backfill **re-attempt** the lost chunks on a later successful pass, or are these rows **permanently dropped** until the wallet is next fully re-walked? If the cursor advances past a partially-failed batch, this is silent `wallet_moments_cache` loss during every spell (dashboard/profile/share cards drift) — the same failure class as the 08-18 reconcile incident, but on the ingest side. If the cursor holds on chunk failure, this self-heals and needs no action. **Re-measure out of spell before drawing either conclusion.** Suggested action for the night pass: read the relevant backfill worker's chunk-failure handling (does it advance the cursor on `wmc_upsert_chunk_failures>0`?) and check whether a subsequent clean run refills the same wallet+edition rows.

## Not re-filed (already tracked)
- Cross-collection MV staleness (ledger 08-20, inbox 2026-08-19T1511Z).
- The saturation spell as a standing condition (inbox 2026-08-19T2107Z + focus.md priority 3 — one root cause: disk-IO budget on SMALL instance; lever is cutting work, never raising timeouts / upgrading).

_Inbox written to mount, push unavailable (pushurl absent on desktop Cowork). Night pass picks up locally._
