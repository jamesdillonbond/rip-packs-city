# Handoff — promote the edge-function Deno CI gate to blocking (2026-07-30)

## What this is

The Supabase edge functions (`supabase/functions/**`) run on Deno and are
excluded from every existing CI check (vitest + `tsc` cover `lib/**` +
`app/api/**/route.ts`; there is no Deno toolchain in the rest of CI). So the
edge **source** was type-checked by nothing — a broken import or a wrong function
signature only surfaced at `supabase functions deploy`. This is the layer behind
the recurring "green-while-blind" edge-function incidents.

## What already landed on `main` (2026-07-30, this session)

Two files, both safe/reversible:

1. **`.github/deno.jsonc`** — a CI-only Deno lint config. Kept OUT of the
   `supabase/functions/` tree on purpose so `supabase functions deploy` never
   discovers it. Excludes `no-explicit-any` (a deliberate, documented pattern
   here) and leaves every other default rule on.
2. **`edge-deno` job in `.github/workflows/ci.yml`** — runs `deno check`
   (type + import resolution) and `deno lint` on the edge functions. It is
   **NON-BLOCKING** (`continue-on-error: true`), exactly how `cadence-lint` and
   `cadence-escrow-tests` were introduced before promotion. A non-blocking job
   cannot fail the CI suite for anyone; it just produces a signal.

**Why it landed non-blocking / unverified locally:** this dev sandbox's outbound
proxy blocks `jsr.io` / `esm.sh` (403), so `deno check` cannot resolve the edge
functions' remote imports here — it is genuinely unverifiable in the sandbox.
GitHub Actions runners have open internet, so **CI is the first place `deno check`
can actually run.** That is the whole reason this is a watch-then-promote handoff
and not a one-shot verified push.

Known local baseline (verifiable without network — `deno lint` is AST-only):
**15 lint findings** — 11 `require-await`, 2 `no-unused-vars`
(`hybrid-custody-events` `startedAtIso`, `sync-nba-projections` `loadTodaysGames`
— both benign dead code, confirmed), 1 `no-inner-declarations`, 1 `no-empty`.

**First CI run finding (2026-07-30, run 30501746703):** `deno check` did NOT fail
on our edge source — it failed resolving a *transitive npm type dep of the
Supabase SDK itself*: `@supabase/functions-js`'s `edge-runtime.d.ts:192`
references `npm:openai@^4.52.5`, which Deno can't type-resolve without a
node_modules dir. Fixed by adding `--node-modules-dir=auto` to the check command
(the remedy the resolver error names). The next run's `deno check` output is the
real edge-source baseline to triage per step 1.

## The remaining step (needs a CI-watchable session — Cowork or Claude Code)

### 1. Read the first `edge-deno` run's output
- GitHub → Actions → CI → latest run on `main` → `edge-deno` job → the
  `deno check` step. (Or via the GitHub MCP: `actions_list` →
  `list_workflow_jobs` for the run, then `get_job_logs` for `edge-deno`.)
- `deno check` type-checks the **whole module graph**, so expect some noise from
  remote deps (e.g. `@supabase/supabase-js` types). Triage OUR code only:
  errors whose file path is under `supabase/functions/`.

### 2. Fix real errors — **redeploy-aware**
- A type/import error in an edge fn is a real bug to fix, BUT editing an edge
  function's source implies a **`supabase functions deploy <name>`** to ship the
  fix — the repo commit alone does not update the deployed function. Do NOT edit
  edge source casually; treat each fix as a deploy.
- The established discipline (CLAUDE.md): keep testable logic in
  `supabase/functions/_shared/` (already saturated — all 25 modules tested), and
  do not modify a flagship edge fn's behavior without a deliberate deploy.
- If `deno check` is clean over our files on the first run, skip to step 3.

### 3. Promote to blocking
- Once `deno check` is green over our files, remove `continue-on-error: true`
  from the `edge-deno` job (mirror the comment cadence-lint/escrow used:
  "Revert: re-add `continue-on-error: true`").
- For `deno lint`: either fix/prune the 15 findings (the 2 dead `no-unused-vars`
  are safe deletes but are edge-source edits → redeploy-aware) or drop the
  `deno lint` step and keep only `deno check` as the blocking gate. `deno check`
  is the high-value half; lint here is low-signal.
- Add a ledger entry (`docs/overnight/ledger.md`, date · what · revert path) and
  update the CI-jobs count in CLAUDE.md's "Testing & CI coverage" section
  (currently "7 jobs" → 8).

## Running it as a Cowork task (if you want it driven for you)

Cowork has the GitHub + Supabase MCP and can watch CI and deploy edge fns, so it
can complete steps 1–3. Paste this into a Cowork session:

> Read the latest `edge-deno` CI job output on `main` (GitHub Actions → CI, or
> the GitHub MCP `actions_list` → `get_job_logs`). Triage only the `deno check`
> errors whose file path is under `supabase/functions/`. For each real error,
> propose the fix and, because editing an edge function requires a
> `supabase functions deploy`, treat it as a deploy — do not silently edit edge
> source. When `deno check` is clean over our files, remove
> `continue-on-error: true` from the `edge-deno` job in `.github/workflows/ci.yml`
> to promote it to a blocking gate, add a `docs/overnight/ledger.md` entry with a
> revert path, and bump the CI-jobs count in CLAUDE.md (7 → 8). Do NOT touch the
> `no-explicit-any` exclusion in `.github/deno.jsonc` — that pattern is
> deliberate. If `deno check` surfaces only remote-dependency noise (paths not
> under `supabase/functions/`), promote directly.

## Revert (undo the whole thing)

`git revert <sha>` of the commit that added the `edge-deno` job + `.github/deno.jsonc`.
Nothing else depends on either file; no prod/DB/deploy state is involved.
