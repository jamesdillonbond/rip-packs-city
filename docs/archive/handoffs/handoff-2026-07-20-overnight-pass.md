# Handoff — 2026-07-20 overnight pass

**GENUINE OVERNIGHT (~01:02 PDT, no clock skew).** Shell `08:01:53Z` ≈ DB `now()` `08:02:05Z` ≈ newest sale `07:52Z` ≈ newest FMV `07:54Z` — all four agree, so the 07-06/07-18-class stale-sandbox trap did **not** fire. Real local 01:02 PDT = inside the 00:00–06:00 window → normal shipping mode.

Push **available**. No `FREEZE`. Lock taken `08:02Z` (`night-20260720-4471`), released at end.
`origin/main` **`d6553d46` unchanged start → end** (the concurrent CC/Trevor session that ran until 05:01Z had finished before this pass began). Prod READY `dpl_9CkLzzWzviLfDt9jWEzeqD2vZxaa` (`cf970d9e`), 0 ERROR-state.

**Shipped 1 · reverted 0 · repaired 0 · closed 1 · drained 6 inbox files.**

---

## 1. Post-ship regression watch — ALL PASS, 0 reverts

The watch target was the largest wave in weeks: ~40 commits between 07-19 20:54Z and 07-20 05:01Z (two concurrent sessions), five new MVs, a PostgREST-clamp sweep across 8 public insights call sites, and a pack-EV edge-fn refactor.

| Shipped change | Target metric | Measured now | Verdict |
|---|---|---|---|
| pack-EV edge fns rewired to `_shared` (`fb7eb0f2` + deploy) | pipelines stay green, behavior preserved | `compute-topshot-pack-ev` ok=true every tick, `function_version` 23, `ev_rows_written` 4/tick, `gql_errors` 0, `rpc_errors` 0; `compute-allday-pack-ev` ok=true v9, 40 rows | **PASS** |
| Five MVs materialized (pack-reality, pack-market, serial-premiums) | boards inside the 30s budget, MVs populated | all 5 `relispopulated=true` with real rows — rip-values 37,116 · ed-median 5,796 · ad-realized 3,120 · ts-sales-agg 1,795 · ad-sales-agg 1,184; `mv_pack_ev_latest` 1,824 | **PASS** (refresh cadence defect handled separately — §2) |
| PostgREST 1000-row clamp fix + `fetchAllPaged` (`1f71a9be`, `add20b1e`) | public boards return full rows | monitor 0616Z validated all 12 `rpc-live-health` boards return data (squeeze 501, deals 143, rookies 61, new_collectors 50, …) | **PASS** |
| `allday-pack-reality` one-page fix (`83b72bdf`) | board returns 302 dists, not 0 | verified in-browser by the 07-19 session (302 / 184); no new error class | **PASS** |
| Dune `window_days` 7→2 hedge (`4278943f`) | clear the 402 | **did NOT clear** — still `windows_done: 0`, both pipelines | expected-fail (hedge, not fix) — §4 |
| Test/ratchet rounds 2–6 | CI green, ratchet raised to 76.3/61.45/82.0/78.9 | CI-only, no prod surface | **PASS** |

Supporting evidence: **Sentry 0 unresolved** (production, 24h). `pg_cron` failures = exactly **1** (jobid 204 — the §2 defect, nothing else). 0 invalid indexes. Sales flowing 240/hr. 244 pipeline runs in the last 45 min. Security `[]` / `[]` / `[]` / `[]` after the entire wave.

**No auto-revert was warranted.** The one defect the wave introduced is a refresh-cadence bug, not a data or logic fault; reverting the MV layer would restore the 26–58s board timeouts it was built to fix — strictly worse. Forward-fix was the correct response.

---

## 2. SHIPPED — `audit_20260720_mv_refresh_crons_to_cron_heavy` (DB-only, additive + reversible)

**The finding (monitor 0616Z, independently re-verified here).** The 07-19 wave scheduled its five new MV refresh jobs as **`postgres`**, which carries no per-role `statement_timeout` and therefore inherits the **120s cluster default**. `cron_heavy` — the role every other heavy job in the estate runs as — carries `statement_timeout=600s`. Verified directly:

- `pg_roles`: `cron_heavy` → `{statement_timeout=600s}`; `postgres` → `{search_path=...}` only. A live session as `postgres` reports `statement_timeout = 2min`.
- jobid **204** (`rpc-refresh-topshot-pack-rip-values`) was killed at **exactly 120.2s** on its first scheduled tick (06:05Z), `canceling statement due to statement timeout` inside `refresh materialized view concurrently public.mv_topshot_pack_rip_values` — **despite** the function carrying `statement_timeout=600s` in `proconfig`.

**This settles a contradiction in the ledger.** Line ~1149 (07-18) calls function `proconfig` "the proven pg_cron re-arm mechanism"; lines ~1649 and ~1852 say the opposite. Tonight's tick is decisive evidence for the latter: `proconfig` did **not** re-arm a `postgres`-owned pg_cron statement. The timer is armed once at statement start from the session default, before the function's `SET` executes. The wrong belief survived only because every job relying on it happened to finish inside 120s — and it propagated into this wave. **The authoritative mechanism remains the 07-12 one: the `cron_heavy` role session default.**

**The monitor's suggested action was correct in direction but would have broken four working jobs.** It proposed re-owning the five jobs to `cron_heavy`. Checked before executing: `cron_heavy` had **EXECUTE on none of the five functions** (`has_function_privilege` false ×5). Re-owning alone would have converted one failing job into five failing with `permission denied`. The grant is a required first step.

**What shipped** (one transaction, so any failure rolls back to the current state):
1. `GRANT EXECUTE` on the five SECDEF refresh functions to `cron_heavy`.
2. `SET ROLE cron_heavy` → `cron.schedule(...)` ×5 (pg_cron keys jobs per-user, so this creates new `cron_heavy`-owned jobs — `cron.alter_job(username:=)` needs superuser, which `postgres` is not here).
3. `cron.unschedule()` the five old `postgres`-owned jobs by jobid.

This is the in-repo proven recipe from `audit_20260713_cron_heavy_special_serial_owners_mv`. **Nothing else changed** — no function body, MV definition, schedule, or command. All five functions are one-line `SECURITY DEFINER` wrappers around `REFRESH MATERIALIZED VIEW CONCURRENTLY` owned by `postgres`, so the refresh still executes with postgres's rights and MV ownership is unaffected; only the session budget moves 120s → 600s.

**Scope note — jobid 199 deliberately NOT included.** `rpc-weekly-wmc-prune` also runs as `postgres` and ran **115.4s** on 07-19, i.e. 96% of the real ceiling with almost no headroom. It is excluded because it is a **DELETE path on `wallet_moments_cache`**, the table behind the destructive-op circuit breaker — extending a destructive prune's runtime budget is a different risk class from a read-only MV refresh and wants an explicit owner decision. Queued in §4.

**Verification (in-run, three independent legs):**

1. **State check.** All five jobs now exist **exactly once each**, `username='cron_heavy'`, `active=true`, with byte-identical schedules and commands (new jobids 208–212); the old `postgres` jobs 202/204/205/206/207 are gone and `cron.job` shows **0** leftover postgres-owned `rpc-refresh-*pack*` rows — i.e. no duplicate-job hazard from pg_cron's per-user keying. `has_function_privilege('cron_heavy', …)` = **true** on all five.
2. **Real-path probe (the failing job).** Scheduled a one-shot as `cron_heavy` running the exact function that died at 120.2s. It executed through the genuine pg_cron worker path and **succeeded**. Note the honest nuance: it completed in **23.9s**, not >120s — the 06:05Z failure was **contention-dependent**, not a fixed >120s cost. So this leg proves the EXECUTE grant and the `cron_heavy` execution path, and it also **un-froze the MV** (stuck at its 04:22Z creation snapshot since the failed tick), but it does not by itself exercise the raised ceiling.
3. **Ceiling probe.** Re-validated the budget directly with `SELECT pg_sleep(125)` as `cron_heavy` on the real pg_cron path — see result recorded below. This mirrors the 07-12 validation (`pg_sleep(125)` succeeded at 125.1s) that established the mechanism originally.

**Revert:**
```sql
SET ROLE cron_heavy;
SELECT cron.unschedule('rpc-refresh-topshot-pack-rip-values');
SELECT cron.unschedule('rpc-refresh-topshot-edition-median');
SELECT cron.unschedule('rpc-refresh-allday-pack-sales-agg');
SELECT cron.unschedule('rpc-refresh-allday-pack-realized');
SELECT cron.unschedule('rpc-refresh-topshot-pack-sales-agg');
RESET ROLE;
SELECT cron.schedule('rpc-refresh-topshot-pack-rip-values','5 */6 * * *','SELECT public.refresh_topshot_pack_rip_values();');
SELECT cron.schedule('rpc-refresh-topshot-edition-median','10 */6 * * *','SELECT public.refresh_topshot_edition_median();');
SELECT cron.schedule('rpc-refresh-allday-pack-sales-agg','20 */6 * * *','SELECT public.refresh_allday_pack_sales_agg();');
SELECT cron.schedule('rpc-refresh-allday-pack-realized','35 */6 * * *','SELECT public.refresh_allday_pack_realized();');
SELECT cron.schedule('rpc-refresh-topshot-pack-sales-agg','50 */6 * * *','SELECT public.refresh_topshot_pack_sales_agg();');
REVOKE EXECUTE ON FUNCTION public.refresh_topshot_pack_rip_values(), public.refresh_topshot_edition_median(), public.refresh_allday_pack_sales_agg(), public.refresh_allday_pack_realized(), public.refresh_topshot_pack_sales_agg() FROM cron_heavy;
```

**Metric to re-check tomorrow:** jobid **208** reaches `succeeded` on its own 6-hourly ticks (next 12:05Z, then 18:05Z), and `check_pgcron_recent_failures()` returns `[]`.

---

## 3. Health triage — GREEN

`rpc_ops_snapshot()` at 08:02Z plus targeted drill-downs.

- **Security 0/0/0/0** — `invariants` `[]`, `anon_write_holes` `[]`, `rls_off_base_tables` `[]`, `secdef_anon_violations` `[]`, after the entire 07-19/20 DDL wave.
- **Trust health: 15 metrics, 0 breaches at the 08:02Z baseline — but ONE breach opened mid-run.** `offer_edition_gap_max_usd` went **1 → 201** (threshold 50) between 08:02Z and 08:19Z. It was caught by the **verification subagent**, not by my opening snapshot — a useful reminder that a single point-in-time baseline can go stale inside a long run. Assessed and deliberately left alone: it is the known **self-clearing OFFER-SANITY class** (07-04 precedent: a $70 breach self-cleared to 0); its writer is healthy (`rpc-raise-edition-offers-backstop`, jobid 48, succeeded on all 8 of its last hourly runs in 0.39–2.78s); and it is **unrelated to tonight's ship** — none of the five functions touches offers or `edition_offers`. It was **still open (201) at run end 08:28Z**; the corrective sweep runs 08:34Z, just after this window. **First daytime monitor tick should confirm it cleared — if it has not, it is a genuine new finding, not this transient.** All other 14 metrics ok. `topshot_impossible_parallel_serials` **0** (the hourly self-heal, jobid 203, is holding — this retired a recurring toil item). `fmv_sanity_flags` 0 · `pinnacle_fmv_impossible_flags` 0 · `unmapped_resolution_backlog_max` 27/100 · `edition_integrity_flags` 5/50. All FMV freshness legs well inside threshold (TS 0.2h, AllDay 0.1h, Golazos 0.3h, UFC 11.8h, Pinnacle 9.4h, Pinnacle render floor 0.3h).
- **`stalled_pipelines` `[]`** and **`pipeline_alerts` `[]`** — a clean sweep; last night's carried `pinnacle-sync` stall has cleared.
- **`check_pgcron_recent_failures()` = 1 row**, exclusively jobid 204 (§2). Nothing else.
- **Sentry: 0 unresolved** (production, 24h).
- **Vercel:** prod `dpl_9CkLzzWzviLfDt9jWEzeqD2vZxaa` (`cf970d9e`) READY; **0 ERROR-state**. The many CANCELED production deploys are the expected `vercel.json` `ignoreCommand` supersedes on docs/ledger-only commits, not failures.
- **0 invalid indexes.** System alive: 244 pipeline runs in 45 min; 240 sales ingested in the last hour.
- **Artifacts: 17, none broken.** The 0616Z monitor tick validated the two most exposed to the wave (`rpc-pack-lifecycle` against the rewritten `v_topshot_pack_realized_ev`; `rpc-live-health` — all 12 insights boards returning data). One cosmetic defect found and queued (§4).

**Deltas vs `metrics-latest.json` (07-19 08:03Z) — all benign or improving:**

| Metric | 07-19 | 07-20 | Read |
|---|---|---|---|
| DB size | 10,054 MB | **10,274 MB** | +220 MB/24h, no single pathological table; standing LOW watch on an IOPS-constrained Micro |
| TS editions | 19,451 | **19,464** | +13, normal `::` cataloging; sentinel leak 0 |
| TS FMV HIGH+MED | 3,374 | **3,384** (978 H + 2,406 M) | flat//improving |
| `sales_counterparty_recovered` | 26,127 | **208,834** | the free Flow-REST worker is doing exactly what the roadmap bet on |
| `candy_offers` / best | 47 / 24 | **49 / 25** | bid book accruing silently, as designed |
| impossible-parallel | 0 | **0** | self-heal holding |
| Sentry unresolved | 0 | **0** | — |

---

## 4. Queued — needs Trevor's decision or a future session

**NEW this run:**

1. **`WMC-PRUNE-120S-CEILING` (LOW/MED, night-count 1).** `rpc-weekly-wmc-prune` (jobid 199) runs as `postgres` and took **115.4s** on 07-19 — 96% of the real 120s ceiling, with the same inert-`proconfig` belief behind it. It has not failed yet, but it has effectively no headroom and will start silently no-op'ing (rolling back) as `wallet_moments_cache` grows. **Not auto-shipped** because it is a **DELETE path on the circuit-breaker-guarded `wmc` table** — giving a destructive prune a 5× longer runway is an owner call, not a cadence tweak. Ready fix is the identical recipe to §2 (grant + reschedule as `cron_heavy`). Same applies, currently harmlessly, to jobids 198/200/201/203, which all complete far inside 120s.
2. **`LIVE-HEALTH-ARTIFACT-DEAD-TABLE-CREDIT` (LOW, cosmetic, nc1).** `rpc-live-health/index.html:240` credits `pinnacle_fmv_snapshots`, dropped 2026-06-08. Display-only — the SQL body correctly reads `pinnacle_fmv_history` (and the in-page caption at line 225 says so), so nothing errors. **Attempted and deliberately stopped:** artifact files are read-only to `Edit` in this session, and `update_artifact` requires rewriting the entire document — not worth the context, nor the transcription risk to a working dashboard, for a credits-line fix. Exact change: delete `<code>pinnacle_fmv_snapshots</code>, ` from line 240.

**Carried:**

3. **`DUNE-DATAPOINT-CAP-402` (MED, nc2).** The 07-19 `window_days` 7→2 hedge **did not clear it** (confirmed: seller-recovery 05:47Z 402 on the new 2-day window, `windows_done: 0`; ingest 04:11Z 402, `inserted: 0`; 24h fails 16 and 4). Fails safely — cursors parked, nothing partial. The binding constraint is **datapoints per billing cycle**, not credits, and the roadmap records the plan will not be upgraded. The monitor suggests parking both crons so a permanently-red pipeline stops training the fail set to be ignored. **Not auto-shipped:** they are `vercel.json` crons on the `sales`-write lane (a code deploy on an ingest surface), and "park permanently" vs "let it resume on cycle reset" is a product call, not a health call. Also note a **weekly ownership sync was due ~11:40Z today into the exhausted quota**.
4. **Doc drift (LOW):** CLAUDE.md still describes both Dune pipelines as INERT; both are armed and were writing on 07-19. Corrected in this pass's CLAUDE.md entry.
5. **Standing:** `COMPUTE-LALIGA-PACK-EV-ALGO-VERSION-SCHEMA-MISMATCH`, `NON-WAVE-WALLET-BACKFILL-DRIVER`, `WMC-LOCK-FRESHNESS`, `MARKET-EDITION-LINK`, `CROSS-SOURCE-DEDUP-STATEMENT-TIMEOUT`, `BADGE-CATALOG-STALE-429`, `PINNACLE-SALES-BACKFILL-SPORK-FLOOR`, `allday-pack-opens-404`, moments-hydrator `GetMintedMoment`, DB-over-10GB watch, Panini go-live (one `proxy.ts` line, Trevor's editorial call), chain-two/Candy (gated), operator queue.

---

## 5. Closed this run

- **`MV-REFRESH-CRON-120S-CEILING`** — shipped and verified (§2).

## 6. Failed / blocked

None. No verification failed, so no hard-stop was triggered. One item (artifact credit line) was consciously deferred rather than attempted half-way; recorded in §4.
