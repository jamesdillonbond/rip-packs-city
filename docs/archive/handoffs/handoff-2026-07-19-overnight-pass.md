# Overnight pass — 2026-07-19

**GENUINE OVERNIGHT (~01:02 PDT, no clock skew).** Shell `08:02:24Z` ≈ DB `now()` `08:02:36Z` ≈ newest sale `07:56Z` ≈ newest FMV `07:54Z` — all four agree, so the 07-06/07-18-class stale-sandbox trap did not fire this run. Real local time **01:02 PDT = inside the 00:00–06:00 window** → normal shipping mode.

Push AVAILABLE (`git push --dry-run` = "Everything up-to-date"). No `docs/FREEZE.md`. Lock taken `08:03Z` (`night-20260719-12828`), prior lock RELEASED. `origin/main` **`ecb59f8e` unchanged start→end** (no concurrent push during the run, unlike the last three nights). Prod code HEAD `fd53124a` READY.

Shipped **1** (DB-only, subagent PASS 9/9), reverted **0**, repaired **0**, **closed 4**. Drained 4 inbox files.

---

## Health — GREEN, cleanest snapshot in a week

`rpc_ops_snapshot()` @ 08:03:06Z plus targeted drill-downs:

| Check | Value |
|---|---|
| security (invariants / anon_write_holes / rls_off_base / secdef_anon) | **0 / 0 / 0 / 0** — all `[]` |
| trust health | **15 metrics, 0 breaches** |
| sentinel TS-UUID editions 48h | **0** |
| `check_pgcron_recent_failures()` | **[]** |
| invalid indexes | **0** |
| Sentry unresolved (production, 24h) | **0** (down from 3 at the 03:06Z tick) |
| Vercel | prod `fd53124a` READY, **0 ERROR-state** |
| DB size | **10,054 MB** |
| `stalled_pipelines` | **1** — `pinnacle-sync` (carried operator item, below) |

Both metrics the 07-18 pass queued as breaching are **confirmed cleared**: `topshot_impossible_parallel_serials` 27 → **0**, `pinnacle_fmv_stale_hours` 29.3 → **9.4** (the 07-18 pg_cron backstop did it without the queued manual `pinnacle_fmv_recalc_render_all()` ever being fired).

Editions: TS 19,451 · AllDay 6,190 · Golazos 575 · UFC 518 · candy_mlb 125. FMV TS HIGH+MED **3,374** (stable; the sales-cooldown redistribution has flattened as predicted — confirm-only).

---

## SHIPPED (1)

### `audit_20260719_wallet_backfill_watchlist_notes_cadence_correction` — DB-only, additive+reversible

**What.** The 7 `wallet-backfill*` rows in `pipeline_cadence_watchlist` carried `notes` reading *"6-hour wave at 00/06/12/18 UTC"*. That has been false since the 2026-07-18 in-route cost gate (`utcHour%12<2`), which makes the real execute waves UTC 00/01 + 12/13. **These notes are concatenated verbatim into `get_pipeline_alerts()` detail text** (verified — the live `pinnacle-sync` alert detail is its own notes string), so the stale text is not cosmetic: it is the cadence description an operator reads *during* a page.

Replaced with the measured truth, including the non-wave driver and tonight's numbers. **Thresholds and severity deliberately UNCHANGED** — see "correctly NOT shipped" below.

**Verification — independent subagent, 9/9 PASS** (fresh context, read-only): snapshot table 7 rows · 7/7 rows carry the new text · 0 rows still match `00/06/12/18` · `max_silent_minutes`/`severity` mismatches **0** across all 7 (per-row confirmed) · 0 collateral rows outside the prefix · `check_public_security_invariants()` `[]` · `check_secdef_anon_execute_violations()` `[]` · `pg_tables rowsecurity=false` **0** · snapshot table `relrowsecurity=true` · **0** anon/authenticated grants on it · `detect_stalled_pipelines()` and `get_pipeline_alerts()` both execute clean and **no `wallet-backfill*` pipeline appears in either** · prose reads clean, no regex artifacts. Migration registered as version `20260719080947`.

Note: RLS + anon-revoke were done **in the same migration as the CREATE**, deliberately — that is the fix for the `SECURITY-SMOKE-RLS-TRANSIENT-1809Z` class the 00:10Z monitor raised (a table created in one migration and normalized ~5 min later opened a window the hourly security smoke correctly caught).

**Revert:**
```sql
UPDATE public.pipeline_cadence_watchlist w
SET notes = a.old_notes
FROM public.audit_20260719_wallet_backfill_watchlist_notes a
WHERE w.pipeline = a.pipeline;
DROP TABLE public.audit_20260719_wallet_backfill_watchlist_notes;
```

**Target metric (re-check tomorrow):** `get_pipeline_alerts()` detail for any `wallet-backfill*` alert quotes the 12h cadence, not 00/06/12/18. Thresholds still 420/high (800/medium for `-complete`) and unchanged.

---

## Post-ship regression watch — 07-18/19 wave: ALL PASS, 0 reverts

The largest wave in weeks (~20+ commits, 10+ migrations, essentially the entire surface <24h old).

| Ship | Verdict |
|---|---|
| `ead32361` candy-offers-indexer + `candy_offers`/`candy_best_offers` | **PASS — first real sweep landed.** 06:50Z tick `ok=true`: **47 offers upserted**, 2 bidders discovered, 0 fetch errors, `deactivated 0`, SOL $75.97. `candy_offers` 47 rows, `candy_best_offers` view returns **24**. The pipeline — not either earlier probe — is now the arbiter of the bid-book question, exactly as the ledger correction asked. |
| `67b46fb4` candy-sales-indexer armed | **PASS** — 06:20Z `ok=true`, `sales_found 0`. Correct by construction (`SALE_TYPES` excludes `bid`); the bid-only book yields nothing and the first printed sale is captured automatically. |
| `sales-counterparty-backfill` (worker + `scb_claim_widen_allday_ufc`) | **PASS, and improving.** Hourly recovered: 07:00Z **1,440/1,440 (100%)**, 04:00Z 1,440, 02:00Z 1,439. Cursor descended to 2026-04-17. `sales_counterparty_recovered` **26,127 rows**. The 3 claim-timeouts clustered in hour 05 are contention-class and self-healing by construction (row stays NULL, re-claimed) — and hour 05 is a known non-wave-driver burst hour, which is corroboration for that queued item rather than a new fault. |
| `ac04c4d7` Panini coverage disclosure | **PASS** — deploy READY; `panini_coverage_summary` present and returns 1 row, so the fail-soft path is not silently carrying the surface. |
| `0f9e9acb` ledger restore + `ledger-guard` CI job | **PASS** — ledger intact at 361 entries on entry, Declined heading + both entries present. |
| `eb5d7f6f` CI-status watch in ops-monitor | **PASS (structural)** — closes the 03:06Z candidate. First scheduled `13,43` tick validates live. |
| `fd53124a` AllDay lock display suppression | **PASS** — deploy READY, prod. No new Sentry class. |
| `b69c6010` Dune seller-recovery armed | **FAIL — see queued item 1.** Cursor correctly parked, zero writes, no harm. |
| `audit_20260718_*` circ floor raise wave5 / pinnacle FMV pg_cron backstop | **PASS, both CLOSED** (0 and 9.4 respectively). |

Security invariants `[]` across all four checks *after* the entire wave.

---

## Correctly NOT shipped (the pre-authorised item whose gate was not met)

**WALLET-BACKFILL-STALL-THRESHOLDS.** The 07-18 21:06Z monitor pre-authorised: *"after a full post-gate day (07-19), re-run the 72h max-gap query; **if** max gap > 420, raise the 6 rows to ~800."*

Measured tonight: **max inter-run gap post-gate = 249 min** across all 7 pipelines, vs the 420 threshold. **The condition is not met, so the thresholds were left alone.** Raising them anyway would have been a real (if small) loss of alarm sensitivity bought with no evidence.

Honest residual, recorded because the margin is thinner than 249 suggests: as of 08:03Z the last wallet-backfill run was 05:50Z (133 min and counting), and the next *guaranteed* wave is 12:00Z. If the ~10Z non-wave burst does not fire, the gap reaches **~370 min — 50 min of headroom, not 171**. That projection is now written into the watchlist notes themselves. If a quiet day pushes it over 420, the raise becomes justified on evidence; it is not justified yet.

---

## CLOSED (4)

1. **IMPOSSIBLE-PARALLEL-27** — `topshot_impossible_parallel_serials` **27 → 0** via `audit_20260718_circ_floor_raise_..._wave5`. Self-healing class behaved as documented.
2. **PINNACLE-SYNC-FMV-STALE (FMV half)** — 29.3 → **9.4** on the 07-18 pg_cron backstop. The queued manual `pinnacle_fmv_recalc_render_all()` was never needed. *Catalog half stays open (below).*
3. **CI-STATUS-IS-NOT-IN-ANY-AUTOMATED-SWEEP** — closed by `eb5d7f6f` (read-only GH Actions conclusion read in ops-monitor, explicit read-only permissions block).
4. **WALLET-BACKFILL-STALL-THRESHOLDS** — closed by measurement (249 < 420); the stale notes it depended on were corrected as tonight's ship.

---

## QUEUED

### 1. DUNE-SELLER-RECOVERY-EXECUTE-400 — MEDIUM, night-count 1 (CC/operator)

`sales-seller-recovery-dune` has failed **every hourly tick since it was armed** (05:47Z, 06:47Z, 07:47Z), all `threw: execute HTTP 400 (2026-06-11..2026-06-18)`, `windows_done 0`.

**Diagnosed as far as read-only allows — the fault is isolated to saved Dune query `8027085`, not to our plumbing:**
- Cursor state is correct and fail-safe: `sales_seller_recovery_state` = `cursor_end 2026-06-18`, `window_days 7`, `floor_date 2020-01-01`. The attempted window is exactly `cursor_end − 7d`. **The cursor only advances on success, so it has not moved, no partial or duplicate writes are possible, and `apply_sales_counterparty_external` (fill-only, idempotent, audited) was never reached.** No damage is accruing — the cost is purely that the 3.6M-row drain has not started.
- The route sends `query_parameters: { start_date, end_date }` where `iso()` = `toISOString().slice(0,10)` ⇒ plain `YYYY-MM-DD` strings (`route.ts:68,145`).
- `workers/dune-proxy` forwards **only** `query_parameters` to `POST /query/<id>/execute` and passes the upstream status straight through (`index.ts:103–123`) — so the 400 originates at Dune.
- **The proxy's parameterised-execute path is proven working** by the healthy `sync-topshot-ownership-dune`, which uses the identical mechanism (`query_parameters: { set_ids }`).

⇒ The 400 is a property of query `8027085` alone: either its declared parameter **names** are not `start_date`/`end_date`, or their declared **types** reject a bare `YYYY-MM-DD`.

**Why not auto-shipped:** (a) `app/api/cron/sync-sales-seller-recovery-dune/route.ts` was committed <24h ago — hot file; (b) it is a `sales`-write lane (off-limits class); (c) **the decisive evidence is unreadable from here** — no Dune MCP is available in this session, and the Dune console is external/operator-only.

**Ready fix A (durable, do this regardless of cause) — make the failure self-diagnosing.** The route discards Dune's 400 body, which is why this is a hypothesis rather than a diagnosis. At `route.ts:153`:
```ts
// before
if (!exRes.ok) throw new Error(`execute HTTP ${exRes.status} (${lastWindow})`);
// after
if (!exRes.ok) {
  const body = await exRes.text().catch(() => "");
  throw new Error(`execute HTTP ${exRes.status} (${lastWindow}): ${body.slice(0, 300)}`);
}
```
One tick after deploy, `pipeline_runs.error` names the exact parameter mismatch.

**Ready fix B (operator, ~2 min, no deploy):** open saved query 8027085 in the Dune console and confirm its two parameters are named exactly `start_date` / `end_date` and typed **text** (or date accepting `YYYY-MM-DD`). Rename/retype to match, or tell CC the real names so the route can be aligned.

**Target metric:** `sales-seller-recovery-dune` logs `ok=true` with `windows_done ≥ 1` and `sales_seller_recovery_state.cursor_end` moves below 2026-06-18.

### 2. COMPUTE-LALIGA-PACK-EV-ALGO-VERSION-SCHEMA-MISMATCH — LOW/MED, night-count 1 (CC + a Trevor judgment call)

`compute-laliga-pack-ev` (Vercel cron `30 5 * * *`) dies daily at `route.ts:186`: `Could not find the 'algo_version' column of 'pack_ev_history'`. Confirmed against `information_schema` — `pack_ev_history` has 21 columns and no `algo_version`. `rows_written 0` every run.

**Not user-facing:** `compute-golazos-pack-ev` writes the same collection successfully every 6h; `pack_ev_board_max_stale_days` **0.48** against a breach of 2, `pack_ev_latest` 1,824 rows.

**Not auto-shipped:** pack-EV route logic is explicitly off-limits (documented invisible-failure history), and the substantive question is an ownership decision, not a typo.

**Correction worth carrying (do not "fix" both):** only the `pack_ev_history` insert is wrong. The second `algo_version` at `route.ts:282` targets **`fmv_snapshots`**, which *does* have that column — that insert is correct and simply never runs because the function returns on the first error.

- **Option A (restore):** delete the single `algo_version` key from the `pack_ev_history` row object at line 186. Restores the route including its FMV-sentinel pass.
- **Option B (retire):** if `compute-golazos-pack-ev` has genuinely superseded this 2026-05-09 fallback, remove the cron entry from `vercel.json`.
- **Explicitly rejected: adding `algo_version` to `pack_ev_history`.** The *healthy* writer does not write that column, so adding it would grow a shared table read by `mv_pack_ev_latest` / `pack_table_rows` / `pack_ev_latest` to serve one broken, possibly-superseded route.

This also lets the long-standing ledger item **Q2 · 2026-05-30 · confirm `compute-laliga-pack-ev` cron cadence** be closed either way.

### 3. PINNACLE-SYNC CATALOG HALF — carried (operator), decisive tick ~2h after this run

Silent **2,765 min (~46h)**, last run 2026-07-17T10:07Z; missed the 07-18 10:07Z tick. Known cron-job.org dropout class. **FMV half is backstopped and healthy** (9.4/30). **Catalog half — new renders/editions — is still unbackstopped.**

The **07-19 10:07Z tick decides it** and lands after this pass ends. A second consecutive miss = the trigger is genuinely dropped/auto-disabled → operator (console is operator-only; already listed in `docs/manual-steps-2026-07-19.md`). If it misses, the catalog half wants the same pg_cron backstop treatment the FMV half got on 07-18.

### 4. Carried, unchanged
`NON-WAVE-WALLET-BACKFILL-DRIVER` (lead: `lib/allow-list/prewarm.ts` `force=true` full-cost walks; tonight's hour-05 claim-timeout cluster is fresh corroboration) · `CROSS-SOURCE-DEDUP-STATEMENT-TIMEOUT` · `BADGE-CATALOG-STALE-429` · `FMV-RECALC-EDITION-FETCH-TIMEOUT-CREEP` · `WMC-LOCK-FRESHNESS` · `MARKET-EDITION-LINK` · `PINNACLE-SALES-BACKFILL-SPORK-FLOOR` · `allday-pack-opens-404` · moments-hydrator `GetMintedMoment` · DB-over-10GB watch (10,054 MB) · chain-two/Candy (gated) · standing operator queue.

---

## Artifacts — the 4-tick standing gap is now UNBLOCKED

`list_artifacts` returns **17**. The last four monitor ticks each reported they could not replay artifact payloads because `C:\Users\TDill\Claude\Artifacts` is outside the connected folders, and each repeated a standing ask to mount it.

**That ask is unnecessary — the directory is directly readable with the `Read` and `Grep` tools using the Windows path.** Verified this run: read `rpc-live-health\index.html` (its `cowork-artifact-meta` block and full embedded SQL, including the `busy`-guard CTE and `jsonb_build_object` payload). `Grep` with an explicit `path` works against it too. Only the sandboxed `bash` cannot see it — which is what the earlier ticks were actually hitting.

**Method for future ticks:** `Read`/`Grep` the artifact `path` from `list_artifacts`, extract the SQL, run it via `execute_sql`.

**Deliberately NOT executed tonight:** the `rpc-live-health` payload is a heavy analytical query (14-day `MATERIALIZED` windows over `fmv_snapshots`) and 08:0xZ sits inside the known contention band, with `sales-counterparty-backfill` running 120-row UPDATE batches every 5 min. Adding that load to chase a green-looking dashboard would be self-inflicted. Dependency validation was done instead and is clean: `pack_ev_latest` 1,824 · `funnel_events` 23/24h · `candy_offers` 47 · `candy_best_offers` 24 · `panini_coverage_summary` 1 · `external_pack_drops` 7 · `sales_counterparty_recovered` 26,127 · invalid indexes 0 · `v_rpc_trust_health` 0 non-ok. **No artifact flagged broken; none repaired.**

Recommend the next monitor tick do a true replay in a quiet window now that the access method is known.

---

## Drift vs `metrics-latest.json` (07-18 15:23Z baseline)

DB 9,878 → **10,054 MB** (+176 / ~17h; crossed 10 GB at the 03:06Z tick — spread across the counterparty audit table, candy/panini/external-pack-drops scaffolds and normal `::` cataloging, no single pathological table). TS editions 19,429 → **19,451**. `topshot_impossible_parallel_serials` 27 → **0**. `pinnacle_fmv_stale_hours` 29.3 → **9.4**. `unmapped_resolution_backlog_max` 24 → **25**. `edition_integrity_flags` 5 → **5**. FMV TS HIGH+MED 3,349 → **3,374**. Sentry 0 → **0**.
