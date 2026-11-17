# Handoff — Dune ownership incremental lane: two route guards before the env flip

**2026-08-22, from Cowork cloud.** Repo HEAD at time of writing: `556415fe`.

## Context

Cowork shipped, live and verified:

- **cron-job.org job 8020459** ("RPC TopShot ownership sync (Dune)") moved `40 11 * * 1` → `40 11 24 * *` — weekly Monday 11:40 UTC → the 24th of each month, same slot. The 24th is `dune_budget_state.cycle_anchor_day`, so every tick lands ~11.7 h into a fresh cycle.
- **Migration `audit_20260822_ownership_backfill_targets_cost_ordering`** — `get_ownership_backfill_targets` re-ordered by true cost and given an optional `p_max_datapoints bigint DEFAULT NULL` bound plus two new columns (`set_moments_est`, `est_datapoints`).

**This handoff is the route half** — two guards in one file that must land *before* `DUNE_OWNERSHIP_INCREMENTAL` is ever set. Both are small. Neither changes behaviour while that env var is unset.

Also settled, so nobody re-chases it: **the Dune query already has its `{{set_ids}}` parameter.** Query 7899011 line 20 is `IN (SELECT CAST(TRIM(x) AS integer) FROM UNNEST(SPLIT('{{set_ids}}', ',')) AS t(x))`, unchanged for two months. The `Cannot cast 'default value' to INT` banner on its Dune page is a **2026-07-07** browser artifact (ULID `01KWXJGE15…` decodes to 2026-07-07T05:58:39Z) — six weeks before the 2026-08-03 API run that completed and returned 114,083 rows. Nothing needs editing on dune.com.

---

## Item 1 — an empty target list must SKIP, not full-walk (blocking; do this one first)

**File:** `app/api/cron/sync-topshot-ownership-dune/route.ts` (529 lines at `556415fe`)

**Where:** inside the `after()` body, the `if (process.env.DUNE_OWNERSHIP_INCREMENTAL) { … }` block — the one whose comment begins "OPTIONAL incremental backfill mode". It ends with:

```ts
        if (batchSets.length > 0) {
          executeBody = JSON.stringify({ query_parameters: { set_ids: batchSets.join(",") } });
        }
```

**Root cause.** `executeBody` stays `undefined` when `batchSets` is empty, and the code below then sends an `/execute` with **no** `query_parameters` — which is the FULL walk: 146,100 rows × 6 columns = **876,600 datapoints, 87.7% of the 1,000,000-datapoint cycle.** So in incremental mode the two states that *should* be cheapest — backfill finished, or `get_ownership_backfill_targets` throwing — are the two that buy the single most expensive run the account can make. The `catch` above it already swallows an RPC error into `refreshNote` and falls straight through.

**Change.** When `DUNE_OWNERSHIP_INCREMENTAL` is set and `batchSets.length === 0`, log the skip and return from the `after()` body without executing anything:

```ts
        if (batchSets.length > 0) {
          executeBody = JSON.stringify({ query_parameters: { set_ids: batchSets.join(",") } });
        } else {
          // Incremental mode ON with nothing to fetch. Falling through here would
          // send an /execute with no query_parameters — the FULL walk, 876,600
          // datapoints — which is the opposite of what "no targets" means. Two
          // ways to land here: the backfill is complete, or the targets RPC threw
          // (see refreshNote above). Both are skips, not full walks.
          await supabaseAdmin.rpc("log_pipeline_run", {
            p_pipeline: PIPELINE_NAME,
            p_started_at: startedAt,
            p_rows_found: 0, p_rows_written: 0, p_rows_skipped: 0,
            p_ok: true, p_error: null,
            p_extra: {
              skipped: "no_incremental_targets",
              query_id: queryId,
              refresh_note: refreshNote,
              budget_datapoints_allowed: budget.datapointsAllowedNow,
            },
          });
          return;
        }
```

`ok: true` is right here — nothing was owed and nothing was spent. `skipped` is already a key this pipeline emits (`dune_not_configured`), so `extra_key_counts` in `pipeline_runs_daily` counts it with no other change.

⚠ The `return` is inside `after()`, which is an async callback — confirm it returns from *that* callback and not from a nested closure once you see the real indentation.

**Revert:** delete the `else` branch. Nothing else references `no_incremental_targets`.

## Item 2 — pass the budget into the targets RPC

**File:** same. Same block, the `supabaseAdmin.rpc(...)` call a few lines above:

```ts
          const { data: targets } = await supabaseAdmin.rpc("get_ownership_backfill_targets", { p_limit: batchN });
```

**Change:**

```ts
          const { data: targets } = await supabaseAdmin.rpc("get_ownership_backfill_targets", {
            p_limit: batchN,
            p_max_datapoints: dpAllowance,
          });
```

`dpAllowance` is already in scope (`let dpAllowance = budget.datapointsAllowedNow;` is declared above the `try`). The new second argument defaults to `NULL`, so an un-updated deploy against the new function keeps working — but then it is unbounded.

**Why it matters.** The targets function is cheapest-first, and the cheap tail runs out. Measured today: all 227 uncovered sets are **311,229,744 datapoints** (~311 free cycles), and the largest single set — Base Set S4 — is **91,979,724 on its own**. Once the walk reaches a set like that, an unbounded batch requests more than a cycle can pay for; the walk truncates at the allowance, **restarts at offset 0 on the next run** (the route's own comment flags this), and burns the entire reservation every cycle without ever finishing that set. `p_max_datapoints` caps the cumulative estimate of the batch.

⚠ It cannot cap it to zero: the function always returns at least the cheapest set even when that one set exceeds the bound, precisely because of Item 1's full-walk fallback. Once Item 1 lands, a follow-up could safely return zero rows instead — not yet.

**Revert:** drop the `p_max_datapoints` key.

## Item 3 — two stale numbers in the route's own comments (cosmetic, same file, same commit)

The budget block's comment reads:

- `🚨 ONE FULL WALK IS 68.4% OF THE MONTH. 114,083 rows x 6 columns = 684,498 datapoints` → the walk is sized by the **table** (146,100 rows), not by the last execution's row count: **876,600 datapoints, 87.7%.**
- `600,000 datapoints (dune_budget_allocation.min_start_datapoints)` → the live value is **880,000**. A reader who trusts the comment will size the wrong gate.

Leave the reasoning prose as is; only the two figures are wrong.

---

## Not in this handoff — the flip itself, which is three simultaneous changes

Do **not** set `DUNE_OWNERSHIP_INCREMENTAL` on its own. It needs all three at once or the lane silently stops after one run:

1. `DUNE_OWNERSHIP_INCREMENTAL=1` on Vercel + redeploy (and optionally `DUNE_OWNERSHIP_BATCH_SETS`, default 10).
2. `UPDATE public.dune_budget_allocation SET min_start_datapoints = <batch cost>, reserved_datapoints = <batch cost × runs per cycle> WHERE pipeline = 'ownership-sync-dune';` — `min_start_datapoints` is **880,000**, sized for the full walk. An incremental batch of 10 currently costs **1,656 datapoints**. After one such run the lane's allowance is still ~898k so it survives, but the moment reserved/min_start are left at full-walk size the arithmetic stops describing the lane at all, and `can_start` becomes a coin flip against whatever else spends the cycle.
3. cron-job.org job 8020459 back to `40 11 * * 1` (weekly) — monthly is only correct while the lane does a full walk.

Cowork can do 2 and 3 from the cloud. 1 is yours.

## Guardrails

- Direct to `main`, no branches, no PRs. If a `claude/*` branch is checked out, `git switch main` first.
- Commit with **PowerShell** `git`, not Git Bash (Git Bash `git commit` can silently no-op). Verify the push with `git rev-list --count origin/main..HEAD` (expect `0`).
- Use PowerShell `Invoke-WebRequest` for any Vercel REST check — `curl` fails silently in Git Bash.
- Vercel Pro `maxDuration` hard cap is **800 s**; this route already sits exactly at 800. Do not raise it — the deploy goes to ERROR invisibly.
- CRLF: full-file writes or `findIndex` on split lines, not string-replace patching.

## Verification

- `npx tsc --noEmit` clean.
- Vercel production deploy reaches **READY**.
- No behaviour change is observable until the env flip: with `DUNE_OWNERSHIP_INCREMENTAL` unset, the added `else` branch is unreachable and the RPC call carries one extra argument that defaults to `NULL`. The next real tick is **2026-08-24 11:40 UTC** and should still be a full walk logging `ok: true`, `refreshed: true`, ~114k rows.
- Positive control if you want one before the 24th: `GET /api/cron/sync-topshot-ownership-dune?norefresh=1` — skips the Dune execute entirely, so it spends nothing, and still writes a `pipeline_runs` row.

**Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.**

## Expected end state

One commit on `main` touching one file, Vercel READY, no metric moves yet — and `DUNE_OWNERSHIP_INCREMENTAL` becomes a safe switch instead of one that buys an 876,600-datapoint walk on its worst day.
