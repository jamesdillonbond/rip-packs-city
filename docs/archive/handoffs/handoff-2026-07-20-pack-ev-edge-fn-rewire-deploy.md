# Handoff — deploy the pack-EV edge-fn rewire + moments-hydrator worker (2026-07-20)

## Context

The **source** for four functions was rewired to import already-tested shared modules (single source of truth), and is committed on `main`. This handoff is **deploy-only** — Supabase edge functions and Cloudflare workers do NOT auto-deploy from a git push, so nothing in prod has changed yet. Each function keeps running its old (behavior-identical) code until you deploy it.

- **Live already (no action):** the `_shared` / `parse` modules + their unit tests + the drift guards are on `main` and green in CI. Prod pack-EV/hydrator behavior is unchanged.
- **This handoff covers:** deploying 3 Supabase edge fns + 1 Cloudflare worker so the deployed code actually imports the shared modules.
- **Relevant commits:** edge-fn rewire `fb7eb0f2`; worker rewire `c3808634` (both on `main`).
- These changes are **behavior-preserving** (verbatim extractions, 31 `_shared` unit tests + a lib↔_shared parity matrix + the updated source-drift guard). The deploy is safe *and* verifiable: the post-deploy check below confirms EV/depletion numbers are byte-identical to pre-deploy.

> Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.

---

## Item 1 — Deploy the 3 supply-weighted pack-EV edge functions

**Files (verified to exist, already committed on `main`):**
- `supabase/functions/compute-allday-pack-ev/index.ts`
- `supabase/functions/compute-golazos-pack-ev/index.ts`
- `supabase/functions/compute-pinnacle-pack-ev/index.ts`
- shared: `supabase/functions/_shared/pack-ev-supply-weighted.ts`

**What changed & why.** Each fn carried an inline copy of the same supply-weight / depletion / weighted-mean-EV math. They now `import { … } from "../_shared/pack-ev-supply-weighted.ts"` (a documented Supabase `_shared` pattern) so the pricing math has one pinned, unit-tested definition. AllDay + Golazos import `supplyWeightPool` + `computeDepletionPct` (they build `pack_drop_pool` weights; the EV itself is computed by the DB RPC `compute_pack_ev_per_edition_weighted`). Pinnacle imports `computeDepletionPct` + `weightedMeanEv` (it computes the displayed EV inline). The extraction is verbatim; `weightedMeanEv`'s `editionCount`/`editionsWithFmv`/`ok` fields reproduce the old loop's counters exactly.

**Deploy (Supabase CLI, from repo root):**

```bash
supabase functions deploy compute-allday-pack-ev   --no-verify-jwt --project-ref bxcqstmqfzmuolpuynti
supabase functions deploy compute-golazos-pack-ev  --no-verify-jwt --project-ref bxcqstmqfzmuolpuynti
supabase functions deploy compute-pinnacle-pack-ev --no-verify-jwt --project-ref bxcqstmqfzmuolpuynti
```

- `--no-verify-jwt` matters: these fns are triggered by pg_cron / cron-job.org with a `?key=<CRON_KEY>` or `Bearer INGEST_SECRET_TOKEN`, NOT a Supabase JWT. **If you deploy via the Supabase MCP `deploy_edge_function` instead, it RESETS `verify_jwt → true`** (documented gotcha) — re-set it to **false** in the dashboard afterward or the crons 401.
- The CLI Deno-typechecks + bundles before deploying, so a wiring/type error **fails the deploy** rather than shipping broken pricing.

**Post-deploy verification (do this before walking away — it's a pricing path):**

1. Trigger each fn once (cron key or Bearer), then read the newest `pipeline_runs` row per pipeline:
   ```sql
   select pipeline, ok, rows_written, extra->>'ev_rows_written' ev_rows, extra->>'ev_rows_built' ev_built,
          extra->>'nodes_no_fmv_coverage' no_fmv, extra->>'function_version' ver, started_at
   from pipeline_runs
   where pipeline in ('compute-allday-pack-ev','compute-golazos-pack-ev','compute-pinnacle-pack-ev')
   order by started_at desc limit 6;
   ```
   Expect `ok=true` and non-trivial `ev_rows_*` in the same ballpark as the runs from before the deploy (compare against `started_at < deploy_time`).
2. **Parity spot-check (the real gate):** pick one Pinnacle dist that had a `pack_ev_history` row before the deploy and confirm the newly-written `gross_ev` / `pack_ev` / `depletion_pct` are **identical** to the pre-deploy values (the rewrite is behavior-preserving, so any difference = a wiring bug → revert). Example:
   ```sql
   select dist_id, gross_ev, pack_ev, depletion_pct, computed_at
   from pack_ev_history
   where collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'  -- pinnacle
   order by computed_at desc limit 10;
   ```

**Revert.**
- Code: `git revert fb7eb0f2` (restores the inline copies), then re-deploy the 3 fns with the commands above.
- If you need prod back on the old code *without* a git revert, `supabase functions deploy` from the parent commit `git checkout fb7eb0f2~1 -- supabase/functions/compute-*-pack-ev` — but the git revert is cleaner.
- The DB RPC (`compute_pack_ev_per_edition_weighted`) is untouched, so AllDay/Golazos EV can't change regardless.

---

## Item 2 — Deploy the topshot-moments-hydrator worker

**Files (verified to exist, already committed on `main`):**
- `workers/topshot-moments-hydrator/index.ts` (rewired to `import … from "./parse"`)
- `workers/topshot-moments-hydrator/parse.ts` (the extracted, unit-tested parse/resolve core)

**What changed & why.** The worker's pure logic (aliased-query build, the per-alias GraphQL parse incl. the partial-error survivor, resolvable filter, edition-key dedupe, ok-flag policy) was extracted to `parse.ts` and unit-tested (23 tests, pinning the recurring `GetMintedMoment` partial-error class). `index.ts` now imports it. Behavior identical.

**Deploy (Wrangler, from the worker dir):**

```bash
cd workers/topshot-moments-hydrator
# On desktop Cowork the sandbox has NO injected push/deploy credential — deploy from
# an environment that has wrangler auth (Trevor's machine).
npx wrangler deploy
```

**Post-deploy verification:**
1. `GET https://topshot-moments-hydrator.<subdomain>.workers.dev/health` → `{ ok: true, worker: "topshot-moments-hydrator", … }`.
2. Watch the next scheduled tick in `pipeline_runs` (`pipeline = 'topshot-moments-hydrator'`): `ok` behavior + `moments_written` / `graphql_failures` / `stubs_created` should look like the pre-deploy runs. A burned/retired moment still nulls only its own alias (partial errors don't fail the chunk) — that's the pinned behavior.

**Revert.** `git revert c3808634`, then `npx wrangler deploy` again. (The worker only ENRICHES `moments`; it never deletes, and `replace_topshot_moments_batch` is unchanged, so a bad deploy can't corrupt data — worst case it writes 0 rows and self-recovers next tick.)

---

## Guardrails (repeat every handoff)

- **Direct to `main`. No branches, no PRs.** If a `claude/*` branch is pre-checked-out, switch to `main` first. (CLAUDE.md non-negotiable.)
- **Commit via PowerShell `git` on Windows** — Git Bash `git commit` can silently no-op. Re-verify the push with `git rev-list --count origin/main..HEAD` (expect `0`).
- **`curl` fails silently in Git Bash for Vercel REST** — use PowerShell `Invoke-WebRequest`. (Not needed for this handoff — no Vercel deploy involved; the edge/worker deploys are Supabase CLI + Wrangler.)
- **Vercel Pro `maxDuration` hard cap is 800s** — anything higher sends the deploy to ERROR invisibly. (N/A here, noted for completeness.)
- **CRLF:** don't string-replace-patch on Windows; use full-file writes or `findIndex` on split lines. (The rewrite is already committed, so this only applies if you re-edit.)
- **Ledger:** this handoff's *source* rewire is already logged (see the 2026-07-20 test-coverage entries). When you deploy, add a one-line `docs/overnight/ledger.md` entry: date · "deployed pack-EV edge-fn + hydrator rewire" · revert path (`git revert fb7eb0f2` / `c3808634` + redeploy).

---

## Expected end state

Four functions deployed so prod runs the shared-module imports (commit `fb7eb0f2` for the 3 edge fns, `c3808634` for the worker); `pipeline_runs` green for all four; a Pinnacle `pack_ev_history` parity spot-check byte-identical to pre-deploy (proving the rewrite changed nothing but the code shape); the pack-EV duplication is now a single pinned source of truth instead of three inline copies.
