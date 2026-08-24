# Handoff / session close — wmc FMV propagation

**2026-08-13 15:50Z (08:50 PT). Cowork cloud session. Thread being archived.**

> ⚠ Scope note: everything below is DB state applied live via MCP. This session could not push;
> the one code half is a patch (see §4).

---

## 1. What is live and working

| | state |
|---|---|
| **pg_cron jobid 303** `rpc-refresh-wmc-fmv-changed`, `7-57/10`, owner `cron_heavy` | **7 runs, 7 succeeded, 0 failed**, avg **394s** (deadline 360s + cancel latency, well inside the 600s kill) |
| `rwfc_state.last_cutoff` (global sweep watermark) | **~30–33 min behind** and holding, vs a sweep that was 100% dead for 10+ hours |
| `refresh_wmc_fmv_drift_active` (08-12 fix) | chunked, deadline-bounded, resumable — no longer ratchets |

Measured outcome (`TABLESAMPLE SYSTEM (3)`, ~66k rows, vs `fmv_current`; 08-12 → 08-13):
Golazos exact **87.9% → 98.3%**, overstated **+23.4% → 0.0%**; AllDay **32.2% → 52.2%**, p95
**14.2× → 8.2×**; Top Shot **7.0% → 11.1%**; UFC 80.0% → 87.1%.

## 2. ⚠ THE ONE OPEN REGRESSION — act on this first

**`rwfd_state` is now going BACKWARDS.** It was converging at ~1.4× realtime on the route's budget:

| time | rwfd behind |
|---|---|
| 08-12 23:38Z | 10h27m |
| 08-13 14:25Z | **4h57m** ← converging |
| 08-13 15:50Z | **6h14m** ← losing ground |

The turn coincides with jobid 303 starting. Plausible: a second heavy sweep on an I/O-starved
instance took the budget the route-scoped one was living on. **Correlated, not proven** — I did not
isolate it, and job 302's labeling backfill is also still writing the same table.

**The fix is the same one 303 got: self-tuning budget + a `cron_heavy` schedule.**
⛔ **Do NOT apply the self-tuning alone.** Under the route's 30s budget the shared helper picks
chunk 5, which is *smaller* than drift_active's current 25 — it would run slower than today. The two
changes are a pair: self-tune **and** move it to `cron_heavy`, or leave it as is.

I deliberately stopped here rather than stacking a second heavy sweep blind on a saturated instance
with the thread being handed over.

## 3. ⛔ MIGRATION PARITY — six migrations are applied to prod with NO committed file

Applied via MCP this session, in order:

```
audit_20260812_drift_active_chunked_resumable
audit_20260812_drift_active_chunk_sized_for_saturation
audit_20260813_refresh_wmc_fmv_changed_resumable          (+ creates public.rwfc_state)
audit_20260813_refresh_wmc_fmv_changed_chunk_fits_budget
audit_20260813_wmc_refresh_budget_self_tuning             (+ cron_heavy grants)
audit_20260813_wmc_changed_chunk_is_not_budget_scaled
```
plus **pg_cron jobid 303** (not a migration; `cron.job` is not reachable from `apply_migration`).

This is exactly the drift class `migration-parity` exists to catch, and it will report them.
**Recover the SQL byte-exactly from prod — do not retype:**

```sql
SELECT array_to_string(statements, E'\n'), md5(array_to_string(statements, E'\n'))
  FROM supabase_migrations.schema_migrations WHERE name = '<name>';
```
Write to `supabase/migrations/<version>_<name>.sql`, confirm the file's md5 matches, commit.

## 4. Code half not pushed

`0003-wmc-propagation-pipeline-runs-logging.patch` — `runRefresh()` records both propagation RPCs in
`pipeline_runs` under their own pipeline names with `p_ok` / `p_error` / `duration_ms`. Proven both
ways (2 new tests fail against the shipped route, all 16 pass against the new one), `tsc` clean,
`git am` verified to a byte-identical tree. **Until it lands, these two writers still have no
DB-visible failure signal** — which is the whole reason a 10-hour outage read green.

## 5. Still open, unchanged

- **There is no catch-all.** Both sweeps are change-driven; drift that settled before the watermark
  is revisited by **neither**. `refresh_wmc_fmv_drift_active` is additionally scoped to the **26**
  `allow_list` wallets. The route comment claiming it rewrites "any held row deviating >25%" is
  wrong and was corrected in the patch.
- **candy_mlb read 79.2% → 2.2% exact** (median ratio 0.987, p95 1.014 — values ~1.3% off). Reads as
  a fresh Candy FMV recompute the denorm has not caught up to, i.e. propagation lag newly visible
  rather than a new defect. **Re-measure after 303 has cycled a few hours.**
- Part C (surface disclosure) not built — genuinely blocked on the labeling drain (job 302).
- Disney Pinnacle is not covered by the confidence writer; its FMV lives in `pinnacle_fmv_history`.
- **No instrument watches propagation health.** It took a `TABLESAMPLE` to see a 10-hour outage. A
  per-collection "% of wmc rows deviating >25% from `fmv_current`" trust arm would catch the next one.

## 6. Verification already done (don't redo)

Signature unchanged on both functions → **1 overload each**; grants `service_role` + `postgres`
(+`cron_heavy` on the changed sweep) EXECUTE only; `rwfc_state` RLS on with anon/authenticated
**read and write false**; `check_secdef_anon_execute_violations()` `[]`;
`check_public_security_invariants()` **0**; RLS-off tables `[]`.

## 7. Reverts

- `SELECT cron.unschedule('rpc-refresh-wmc-fmv-changed');` — **as `cron_heavy`, jobname only** (the
  `jobid` overload permission-denies).
- Each migration names its predecessor as the revert target in its own header comment.
- `DROP TABLE public.rwfc_state;` only when reverting past the resumable version.
- No data unwind in any case — all six are behaviour-only.
