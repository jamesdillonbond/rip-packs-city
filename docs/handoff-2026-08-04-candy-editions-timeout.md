# Handoff — `candy-editions-ingest` isn't silent, it's being killed at the 300s wall

**Date:** 2026-08-04 · **For:** Claude Code
**Trigger:** RPC Sentinel WARN, 2026-08-03 23:37Z — "Pipeline Silence: candy-editions-ingest silent 2337m (>1800m, info)"

---

## Context

Cowork diagnosed this from prod telemetry + Vercel runtime errors and **shipped the watchlist half only** (`audit_20260804_candy_editions_ingest_watchlist_severity`). The remaining fix is `export const maxDuration` in route code, which Cowork cannot push.

**The sentinel's wording is misleading and that matters:** this arm is not silent. It is timing out and being killed *before* it can write its `pipeline_runs` row, so a hard failure presents as an absence. Same class as the `pinnacle-sync` `after()` defect — a run that dies before logging leaves no evidence that it ran at all.

---

## Evidence

**Vercel runtime errors, route `/api/ingest/candy-editions`, last 3d:**

```
Vercel Runtime Timeout Error: Task timed out after 300 seconds
count=1  routes=/api/ingest/candy-editions
first=2026-06-16T13:24:05Z   last=2026-08-03T08:40:21Z
```

**`pipeline_runs_daily` — the arm was perfectly reliable until it wasn't:**

| day | runs | ok | rows_found | rows_written | **duration** |
|---|---|---|---|---|---|
| 2026-07-30 | 1 | 1 | 27,876 | 28,483 | 61.4s |
| 2026-07-31 | 1 | 1 | 27,876 | 28,483 | 68.5s |
| 2026-08-01 | 1 | 1 | 27,876 | 28,483 | 71.4s |
| 2026-08-02 | 1 | 1 | 27,876 | 28,483 | **197.4s** |
| 2026-08-03 | — | — | — | — | **killed at 300s** |

**Row counts are byte-identical across all five days**, so the 2.8× jump between 08-01 and 08-02 is not data growth — it is contention or a route slowdown. It then crossed the wall on 08-03.

⚠ **Note on method:** querying `pipeline_runs` directly showed "2 runs in 7 days", which looks like a long-dead pipeline. That is retention (~73h), not absence — `pipeline_runs_daily` is the correct source and shows a clean daily cadence. Worth remembering; I nearly filed this as a dead cron.

`vercel.json` is **not** the problem — the entry is present and correct at `{"path": "/api/ingest/candy-editions", "schedule": "40 8 * * *"}`.

---

## Item 1 — raise the ceiling

**File:** `app/api/ingest/candy-editions/route.ts`, line 29.

```ts
export const maxDuration = 300     // -> 800
```

800 is the **Vercel Pro hard cap**; anything above it sends the deploy to ERROR invisibly. At the last successful duration (197s) this restores ~4× headroom instead of 1.5×.

**Revert:** `git revert <sha>`. Single line, no DB state.

**Verify:** `npx tsc --noEmit` clean, deploy READY, then confirm the **2026-08-04 08:40 UTC** tick writes a `pipeline_runs` row. Check both:

```sql
SELECT day, runs, ok_count, duration_ms_max FROM pipeline_runs_daily
WHERE pipeline='candy-editions-ingest' AND day >= current_date - 2 ORDER BY day DESC;
```

and that `get_runtime_errors` shows no new timeout after the deploy.

## Item 2 — worth doing, but measure first

Raising the ceiling buys headroom; it does not explain the 2.8× jump. **One testable hypothesis before you optimise anything:** the 08-02→08-03 window is exactly when `fmv-recalc` was stuck reprocessing ~997 editions every 20 minutes (see `docs/handoff-2026-08-03-fmv-sweep-cursor-stall.md`). That sweep now does ~497 rows on a cursor that advances, so DB contention should be materially lower.

**So: ship Item 1, let the 08-04 tick run, and read its duration before touching the route's internals.** If it comes back near 61–71s, the slowdown was the stalled sweep and there is nothing further to fix. If it stays near 197s, the route itself regressed and `paginateGroup` deserves a look — it walks the whole Metaplex collection in one request with no resumable cursor, which is the same unbounded-single-pass shape that just bit us in `fmv-recalc`.

Do not pre-emptively paginate it. Measure first.

---

## Already shipped by Cowork — no action needed

`audit_20260804_candy_editions_ingest_watchlist_severity` corrected two things in the watchlist row:

1. **Severity `info` → `medium`.** The old note justified `info` with *"candy_mlb stays is_active=false pre-launch"*. **Candy went live 2026-07-31** (`CANDY_MLB_PUBLIC=true`); `candy-sales-indexer` was correctly raised `medium`→`high` at that flip and **this row was missed**. Not raised to `high` because editions change slowly (byte-identical row counts for five days) — it does not warrant paging the way the price feed does.
2. **The threshold arithmetic was wrong.** The note claimed 1800m *"absorbs one missed daily tick + margin"*. It does not — a daily cron missing one tick is silent for 48h = 2880m. It fires on the **first** miss. That is correct for a live collection, so the number stands; only the stated reason was wrong.

**Revert:** `UPDATE pipeline_cadence_watchlist SET severity='info' WHERE pipeline='candy-editions-ingest';`

---

## Guardrails

- Direct to `main`, no branches, no PRs. PowerShell `git`; verify with `git rev-list --count origin/main..HEAD` (expect 0).
- Vercel Pro `maxDuration` cap is **800s** — above it the deploy ERRORs invisibly.
- Log to `docs/overnight/ledger.md` with the revert path; ledger committed **before** the code.
- ⚠ Git history rewritten 2026-08-03 — find pre-purge commits by message, not SHA.

**Claude Code's direct file inspection wins over this doc on any disagreement.**

## Expected end state

One line on `main`, deploy READY, and the 08-04 08:40 UTC tick writing a `pipeline_runs` row with a duration you then use to decide whether Item 2 is real.
