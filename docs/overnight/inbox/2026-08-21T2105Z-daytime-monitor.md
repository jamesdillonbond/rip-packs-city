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

---

## ✅ RESOLVED 2026-08-24 (PT) — item 3's question is ANSWERED, and the alarming branch is REFUTED

**Answered by Claude Code, interactive, on Trevor's Windows box.** This filing asked the night pass to *"read the relevant backfill worker's chunk-failure handling (does it advance the cursor on `wmc_upsert_chunk_failures>0`?) and check whether a subsequent clean run refills the same wallet+edition rows."* Both halves were done. **The answer is the benign branch: the loss self-heals, and no action is needed.** ⚠ Annotated in place rather than archived, per focus.md's append-only rule.

⚠ **I measured DURING a spell rather than waiting for a quiet window, and that is legitimate HERE for a reason worth stating: the question is about SET MEMBERSHIP (did the rows come back?), not about DURATION.** CLAUDE.md's "every duration that hour is uninterpretable" bars timing comparisons; row counts and set differences are load-independent. Contemporaneous positive control at read time: **`io_wait=35 / active=36 / total=47`** — 35 of 36 active sessions in IO wait, the deepest spell reading recorded in these docs.

### 1. The source answer: there is NO persisted cursor, and a chunk error never advances one

- **id-only path** (`lib/chains/flow/wallet-backfill-helpers.ts:622-623`): `const cachedIds = skipCached ? await loadCachedMomentIds(...) : new Set(); const idsToWrite = skipCached ? onChainIds.filter(id => !cachedIds.has(id)) : onChainIds`.
- **paginated path** (`:1540-1542`): `cachedMap = await loadCachedMomentIdsAndKeys(...)`, and the pre-flight short-circuit requires **every** on-chain id to be present AND enriched before it skips the chunk loop.

**Both re-derive the work set from the LIVE `wallet_moments_cache` contents on every run.** A row lost to a failed upsert chunk is by definition still absent from that cache, so it is still in the next cycle's diff. ⚠ **`nextStartIndex` is assigned in exactly ONE place — the soft-deadline break at `:1677` — never on a chunk error**, and it indexes an id list re-fetched from chain each run. So the premise *"if the cursor advances past a partially-failed batch"* does not hold: the cursor is a within-run resume offset, not durable state.

### 2. The empirical answer: 20 of 20, zero rows still missing

For AllDay wallets that logged `chunk_rows_lost > 0` between 72h and 6h ago, comparing current `wallet_moments_cache` rows against that run's own reported `on_chain_count`:

**`wallets_checked 20 · covered 20 · still_short 0 · rows_still_missing 0`**

Two individually decisive rows: **`0x0a84394d162c46de` lost ALL 410 rows in one run and now holds 416**, and **`0x0d744d23165bfb6c` lost 400 and now holds exactly 1,599 — its `on_chain_count` to the row.** (Counts above `on_chain_count` are expected: AllDay custody/locked moments are deliberately written outside the on-chain id walk.)

### 3. ⚠ MY FIRST INSTRUMENT SAID "NEVER REPAIRED" AND IT WAS A NULL INSTRUMENT

I first asked *"did any later run for this wallet report `terminated_reason: all_ids_already_enriched`?"* — the reason that structurally proves full coverage. It returned **`lossy_wallets 180 · proven_fully_repaired 0`**, which reads exactly like *"not one of 180 wallets was ever repaired"* and would have escalated this filing to a P1.

**The positive control killed it:** `all_ids_already_enriched` fired **1 time in 2,266 `wallet-backfill-allday` runs** in 48 h (Pinnacle: 22 of 2,227). A reason that essentially never fires cannot evidence absence — **0 of 180 is exactly what a perfectly-working repair would also produce.** This is CLAUDE.md's *"a NULL result needs a positive control"* rule paying for itself in one query; without it I would have filed the opposite conclusion with real numbers attached.

### 4. And a no-change control, because a POSITIVE needs one

"20 of 20 covered" is only meaningful if the comparison can ever say otherwise. Run unchanged against the **Pinnacle** lane it reports **`covered 19 · still_short 1 · rows_still_missing 29`** — so the instrument discriminates rather than always answering "covered".

### 5. What IS still true, and it is latency rather than loss

The in-cycle loss is real and large: **251,578 rows across 1,294 runs and ~200 wallets in 72 h** (`allday` 196,772 / `wallet-backfill` 32,021 / `pinnacle` 19,778 / `ufc` 1,979 / `golazos` 1,028). So **during a spell a profile / dashboard / share card CAN under-report a wallet** until the next cycle repairs it. Repair latency: the next 6 h wave for high-priority wallets; **up to ~24 h for low-priority ones**, because `seeded_wallets.last_refreshed_at` gates them (`SEED_REFRESH_LOWPRI_INTERVAL_HOURS`, default 24) and is stamped even when chunks failed. ⚠ **`chunk_rows_lost` is therefore an upper bound on rows lost THIS RUN, not on rows lost permanently — do not read the 72 h sum as a data-loss figure.**

### 6. Attribution of the pool exhaustion itself, recorded but NOT re-opened

Grouping Vercel's `Timed out acquiring connection from connection pool` (PGRST003) by route: **862 of ~900 in 12 h — and 362 of 387 in a 10-minute sample — are the five `wallet-backfill*` lanes.** Live `pg_stat_activity` at the same moment shows the waits are **`IO/DataFileWrite` (19 PostgREST sessions) and `LWLock/WALWrite` (9 in `COMMIT`)** — a **WRITE**-side saturation. Public read surfaces were 503ing behind it (`/api/fmv/demo`, `/api/edition-history`, `/api/badges`, `/api/collection-series`, `/api/recent-sales`, `/api/public/insights/pack-sniper`) and the smoke test logged hard failures. ⛔ **Per focus.md PRIORITY 3 this is NOT a new investigation** — it is the one known root (SMALL-instance IO budget) with a sharper attribution than before. Recorded so the attribution is not re-derived, not as a request to act.

### 7. Verdict

**No code change. No action.** The existing design — re-derive the work set from the cache on every run, never persist a cursor past a failure — is already the correct one, and CLAUDE.md's warning about *"a fix that would have made an accurate surface inaccurate"* applies directly: acting on the alarming reading would have added retry machinery to a path that already self-heals, on a hot ingest lane that is off-limits to autonomous shipping anyway.
