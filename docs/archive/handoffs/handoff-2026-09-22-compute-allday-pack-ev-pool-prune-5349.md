# Handoff — `compute-allday-pack-ev` fails every run: `pool prune 5349: Bad Request`

> ✅ **SUPERSEDED — DONE 2026-09-22 11:34 AM PT, no action needed.** Deployed as `compute-allday-pack-ev` v59 (v10 source) by the
> Cowork daytime pass, reconciled into `main` by `ef84e5d64`, verified on the real caller (first run 11:37 AM PT ok=true,
> editions_with_fmv 1,000 → 1,463, cursor advancing). v10 also fixes a second bug this handoff did not name (the
> PostgREST 1,000-row cap on `get_fmv_for_editions`). See ledger 2026-09-22 and `docs/handoff-2026-09-22-daytime-autonomous-pass.md`.
> ⚠ The "PAT in `remote.origin.pushurl`" scope line below is itself stale — that route is dead.

**For Claude Code on Trevor's box.** One item. Edge-function fix (`supabase/functions/compute-allday-pack-ev/index.ts`) — must be committed to `main` **and** redeployed.

> This blocker is specific to the Cowork cloud session that wrote this (no git credentials). Trevor's machine and Claude Code push normally via the PAT in `remote.origin.pushurl`. Commit these files as usual.

> **Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.**

## Context

- Live/shipped already: nothing for this — the last touch to this function was **R123 / gate-key rotation, deployed v52 on 2026-09-20** (ledger). Current `origin/main` HEAD at authoring: `70eb0573`.
- This handoff covers **one edge-function bug** introduced by R123's new upsert-then-prune pool logic. Nothing else.

## The bug

`compute-allday-pack-ev` has **failed every run since 2026-09-20 9:37 PM PT** — last OK run `2026-09-21 04:37Z`, then 75/97 runs failed (77%), alert self-escalated to **HIGH**. Every failure is identical: `1 pool write error(s): pool prune 5349: Bad Request`. Instance is calm (not a saturation spell), so the HTTP 400 is a real deterministic fault.

### Root cause (confirmed, not inferred)

Phase 3 of `index.ts` (the R123 upsert-then-prune block, ~lines 289-296) prunes each distribution's stale pool rows with a **negative `in` filter that inlines every kept edition UUID into the DELETE request URL**:

```ts
const keep = rows.map(r => `"${String(r.edition_id)}"`).join(",")
let prune = supabase.from("pack_drop_pool").delete()
  .eq("collection_id", ALLDAY_COLLECTION_ID).eq("dist_id", distId)
if (keep) prune = prune.not("edition_id", "in", `(${keep})`)
const { error: de } = await prune
if (de) poolWriteErrors.push(`pool prune ${distId}: ${de.message}`)
```

For dist **5349** that keep-list is **779 UUIDs ≈ 30 KB of URL**, which exceeds the PostgREST/gateway URL-length limit → **HTTP 400 Bad Request**.

Verified read-only against prod (project `bxcqstmqfzmuolpuynti`):

- Dist 5349 pool: **779 rows, 0 null edition_id, source `gql`** — the upsert succeeds (rows land, `last_refreshed_at` fresh); only the prune 400s.
- **In this run's active recompute set, 5349 (779 rows) is the largest; the next, 7580 (536 rows), prunes fine.** So the URL breakpoint sits between **536 and 779** kept ids — a length limit, not bad data.
- The bigger stored dists (4184 = 3,097 rows, 7584 = 1,604, 1606 = 1,508) **never fail because they are stale from 2026-07-17 and are no longer recomputed**, so their prune never runs. That is why only 5349 fails today — and why any dist that grows past ~600 active editions will hit the same wall next.

### Blast radius

Contained so far: trust-health shows **no AllDay staleness breach** (`allday_fmv_stale_hours` 0.1). The upsert lands 5349's rows, and the failure is per-dist (the loop `continue`s), so the other dists still compute. The cost is that the run is marked `ok=false` every time (correct — R123's `ok` derives from whether writes landed) and 5349's stale pool rows are never pruned, so `pack_drop_pool` for 5349 slowly accumulates rows the weighted-EV RPC shouldn't weight. Not yet user-visible, but it is a real, escalating, unfixed break.

## The fix

Replace the URL-inlined id-list prune with a **timestamp prune**: stamp every written row with one run timestamp, then delete this dist's rows whose stamp is older than that. Tiny URL, no id list, scales to any pool size.

⛔ **Do NOT "just chunk the prune."** A negative `in` filter cannot be chunked — deleting `not in (chunkA)` would delete rows that are in chunkB. The timestamp approach is the correct shape.

**Edit 1 — capture one run timestamp before the pool rows are built.** Find where the per-dist pool rows are constructed in Phase 2 (the `poolRowsByDist[distId] = pooledEditions.map(...)` block, ~line 257). Immediately **before** that build loop starts, add:

```ts
const runStamp = new Date().toISOString()
```

**Edit 2 — stamp rows with `runStamp`.** In that same `.map(...)` row object, change:

```ts
last_refreshed_at: new Date().toISOString(),
```

to:

```ts
last_refreshed_at: runStamp,
```

(Every row written this run now carries the identical `runStamp`; the upsert's `onConflict` updates kept rows to it too.)

**Edit 3 — replace the prune (the block quoted above) with:**

```ts
const { error: de } = await supabase.from("pack_drop_pool").delete()
  .eq("collection_id", ALLDAY_COLLECTION_ID)
  .eq("dist_id", distId)
  .lt("last_refreshed_at", runStamp)
if (de) poolWriteErrors.push(`pool prune ${distId}: ${de.message}`)
```

Rows written/updated this run have `last_refreshed_at === runStamp` (not `< runStamp`), so they survive; any row not re-written has an older stamp and is deleted. Remove the now-unused `keep` line.

Deliver as a full-file replacement of `supabase/functions/compute-allday-pack-ev/index.ts` per CLAUDE.md conventions (the three edits above describe the change precisely; ship the whole file).

## Ship + verify

1. `npx tsc --noEmit` — clean. (Edge fn is Deno; also `deno check supabase/functions/compute-allday-pack-ev/index.ts` if deno is installed.)
2. **Deploy the edge function** — the repo commit alone does NOT fix prod (creates repo/prod drift, which CLAUDE.md flags). `supabase functions deploy compute-allday-pack-ev --project-ref bxcqstmqfzmuolpuynti` (or let Cowork deploy via `deploy_edge_function`). This bumps it past v52.
3. **Verify by the real caller**, not a manual invoke: wait for the next pg_cron tick (~every 30 min) and read:
   ```sql
   SELECT started_at, ok, left(coalesce(error,''),80) AS err
   FROM pipeline_runs WHERE pipeline='compute-allday-pack-ev'
   ORDER BY started_at DESC LIMIT 3;
   ```
   Expect `ok=true`, empty error, and `pool_write_errors: 0` in the run's counters. Confirm dist 5349's pool no longer accumulates: it should hold exactly its written row count with `max(last_refreshed_at)` = the latest run.
4. Trust-health arm `allday_fmv_stale_hours` should stay `ok`.

**Revert path:** `git revert <fix commit>` on `main`, then redeploy `compute-allday-pack-ev` from the reverted source (returns to the v52 id-list prune). DB-side: no migration, no data mutation — the fix only changes which rows the prune deletes, so nothing to unwind.

## Guardrails (repeat every handoff)

- Direct to **`main`** — no branches, no PRs (CLAUDE.md non-negotiable). If a `claude/*` branch is pre-checked-out, switch to `main` first.
- Commit via **PowerShell `git`** on Windows (Git Bash `git commit` can silently no-op). Re-verify the push: `git rev-list --count origin/main..HEAD` → expect `0`.
- **Commit the ledger BEFORE the code** so the code commit is the tip and auto-deploys (a docs-only tip suppresses the Vercel deploy). Append a ledger entry: date · `compute-allday-pack-ev` prune fixed (timestamp prune, v53) · revert = revert commit + redeploy prior version.
- `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest`.
- Vercel Pro `maxDuration` hard cap is **800s** (not relevant here, but standing rule).

## End state

`main` carries the timestamp-prune fix, `compute-allday-pack-ev` redeployed (≥ v53), the next cron tick lands `ok=true` with `pool_write_errors: 0`, and the HIGH `failure_rate` alert clears once post-fix runs outnumber the pooled pre-fix window.
