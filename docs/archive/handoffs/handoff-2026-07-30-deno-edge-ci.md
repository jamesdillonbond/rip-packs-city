# Handoff — promote the edge-function Deno CI gate to blocking (2026-07-30)

## UPDATE 2026-07-31 (Claude Code) — root-caused the 16 residual errors; the fix is a small, well-scoped deploy-verify task now

CI-adjudicated diagnosis (runs 30665456029 + 30665637733) narrowed the residual
from 21 → **16 errors**, and they are ALL toolchain-resolution, not edge-source bugs:

- **FIXED (shipped): the `_shared` "Cannot find module ./cdc" class** — added
  `--unstable-sloppy-imports` to the `deno check` (and a `deno cache` prestep) in
  ci.yml. The `_shared` modules import `./cdc` extensionless because they are
  DUAL-CONSUMED by vitest/tsc (which reject an explicit `.ts` extension); sloppy
  imports lets Deno resolve them. CI-only, no deploy impact.
- **The 16 that remain are a genuine flag conflict, proven both ways in CI:**
  - `--node-modules-dir=auto` is **required** — the SDK's `edge-runtime.d.ts`
    pulls a transitive `npm:openai` type dep that only resolves in node_modules
    mode. Dropping the flag → `deno check` fails in <1s with a hard resolution
    error (verified run 30665637733).
  - BUT node_modules mode **rejects** the SDK's jsr-**subpath** import
    `@supabase/functions-js/edge-runtime.d.ts` (×12) and the deno.land-**URL**
    import `std/http/server.ts` (×2) as `TS2307 "not a dependency"`. Bare jsr
    packages (`@supabase/supabase-js`) resolve fine; subpaths/URLs don't. The last
    2 are `TS7022` implicit-any cascades in `compute-topshot-pack-ev` (`r`/`conn`)
    that disappear once the SDK types load.

### The remaining fix (edge-source, deploy-verify session)
**TESTED & REJECTED (run 30665898605):** remapping `edge-runtime.d.ts` `jsr:`→`npm:`
did NOT help — still `TS2307 "not a dependency"`. The rejection is about the
**subpath import itself** under `--node-modules-dir=auto`, not the jsr/npm scheme
(bare packages like `@supabase/supabase-js` resolve; a `/edge-runtime.d.ts`
subpath to an undeclared package does not). Reverted to the deploy-proven `jsr:`.

**The real fix — remove the type-only imports, which unlocks everything:**
1. Delete the `import "@supabase/functions-js/edge-runtime.d.ts";` side-effect
   line from the 12 fns that have it. It's TYPE-ONLY — Deno provides `Deno.serve`
   and the edge globals natively, so `deno check` doesn't need it. Removing it
   ALSO removes the transitive `npm:openai` type dep it drags in.
2. With `npm:openai` gone, **drop `--node-modules-dir=auto`** from the `edge-deno`
   `deno check`/`cache` steps in ci.yml. Deno's default global cache then resolves
   the `std/http/server.ts` URL imports (the 2 that fail today) AND the jsr
   packages — clearing the 2 URL errors, and the 2 `compute-topshot-pack-ev`
   `TS7022` cascades clear once the SDK types load cleanly.
3. Edge-source change → **redeploy the touched fns** (deploy-verify: ship one
   low-risk fn first, confirm `ok:true` on its next cron tick). Then re-run CI; if
   `deno check` is green over our files, drop `continue-on-error` from `edge-deno`
   and bump CLAUDE.md's CI-job note (7→8 blocking).

Keep `--unstable-sloppy-imports` regardless (it fixed the `_shared/cdc` class).
This is a bounded task for a Deno + deploy session — the diagnosis is complete.


## UPDATE 2026-07-31 (Claude Code) — 3 genuine `deno check` bugs fixed; residual is import-resolution

The `deno check` error count is down from the 24-baseline to **~16**, and the
remaining errors are **not edge-source logic bugs** — they are import-resolution
/ type-environment issues. What changed this session (commit `b4c6f384`, all
type-only or genuine-bug, none redeployed):

- **`scan-pinnacle-wallet/index.ts:150` (TS2339) — was a REAL PROD BUG.** The
  June-10 fix `acf85c04` deleted the `.from("wallet_moments_cache")` line while
  editing `onConflict`, so `supabase.upsert(...)` threw at runtime — every
  Pinnacle wmc write from this fn has crashed since June 10. Restored `.from(...)`.
  ⚠ **needs `supabase functions deploy scan-pinnacle-wallet`** to reach the live fn
  (no cron caller found; opportunistically invoked).
- **`backfill-topshot-base-parallel-probe/index.ts` (TS2783/TS2785)** — `...summary`
  spread was clobbering the refined `done`/`cursor` telemetry; reordered.
- **`compute-topshot-pack-ev/index.ts` (TS2322)** — `timer` typed
  `ReturnType<typeof setTimeout>` (Deno=number, Node=Timeout); type-only, no
  redeploy needed for correctness (flagship money fn — behaviour byte-identical).

**Residual ~16 errors are ALL import-resolution (not code):** `TS2307
"@supabase/functions-js/edge-runtime.d.ts"` + `std/http/server.ts` reported "not
a dependency" (~14 fns), and `_shared/pinnacle-deposit-parse.ts` "Cannot find
module ./cdc" (the `_shared` modules are DUAL-CONSUMED by vitest/tsc, which break
on an explicit `.ts` extension, so it can't simply be added). These could NOT be
verified/fixed from the dev sandbox (proxy blocks jsr/esm, so `deno check` can't
run locally). The `compute-topshot-pack-ev` TS7022 `r`/`conn` implicit-any are
very likely CASCADES of the broken type environment (the edge-runtime types
failing to load), so fixing the import resolution should clear them too.

**Next deno-in-the-loop session:** the remaining work is the import map / check
invocation (likely: whether `--node-modules-dir=auto` + the jsr subpath / URL
imports resolve; whether to map `@supabase/functions-js/edge-runtime.d.ts` to
`npm:` instead of `jsr:`; the `_shared/*.ts` extension tension). Iterate against
CI's `edge-deno` job (the only place `deno check` runs). Once green over our
files, drop `continue-on-error` (see step 3 below). Gate stays non-blocking.


## UPDATE 2026-07-30 — the import-map refactor is DONE (Trevor chose the full path)

The refactor the "remaining step" below anticipated has now landed on `main`:

- **`supabase/functions/deno.json`** — an import map giving every function
  bare-specifier deps: `@supabase/supabase-js` → `jsr:@supabase/supabase-js@2`,
  `@supabase/functions-js/edge-runtime.d.ts` → the versioned jsr path,
  `std/http/server.ts` → the pinned deno.land std. supabase-js was pinned inline
  at a mix of `@2` / `@2.39.0` / `@2.45.0` (nobody pinned deliberately — all v2,
  same createClient/query API); **standardized to jsr `@2`** (Supabase's own edge
  template default). lint config (`exclude no-explicit-any`) moved here too;
  `.github/deno.jsonc` deleted.
- **36 function `index.ts` files** rewritten from inline `https://esm.sh/…` /
  `jsr:` import specifiers to those bare specifiers. **Import lines only** — no
  logic changed (verified per-file; `git diff` shows only the import statements).
  Cleared ~60 `no-import-prefix` / `no-unversioned-import` lint findings.
- **Verified locally:** `deno lint` now 15 findings (down from 76; the 15 are
  pre-existing style — require-await/no-unused-vars/no-empty/no-inner-declarations,
  now informational `|| true`). Full vitest `_shared` drift-guard + edge + parity
  suites (509 tests) green — the rewrite didn't disturb the shared layer.
- **Still can't verify `deno check` locally** (proxy blocks jsr/esm), so the job
  stays non-blocking until a CI run shows check green, then flip.

### ✅ UPDATE — the import-map deploy path is already VALIDATED
A concurrent session (commit `e50c2320`, 2026-07-30) deployed
**`hybrid-custody-events` v12 WITH the repo's `supabase/functions/deno.json`
import map + bare specifiers** (resolving supabase-js to `jsr@2`). It **bundled
cleanly and ticks `ok:true`** post-deploy — proving `supabase functions deploy`
resolves the import map correctly at deploy+runtime. So caveat #1 below is
largely retired: the mechanism works. (The other 3 fns that session deployed —
`ingest-pinnacle-mints` v4, `pinnacle-owner-discovery(-forward)` v22/v26 — were
shipped as MINIMAL-DIFF **inline-import** bodies, so THOSE deployed versions
still use `esm.sh@2.45.0`, not the repo's bare specifiers; a future
deploy-from-repo will switch them to the (now-proven) import-map form.)

### ⚠ TWO things the deploy-verify step MUST heed
1. **The repo source no longer matches the DEPLOYED functions.** Nothing was
   redeployed *for this refactor*, so most live functions keep running their old
   inline-import code. The NEXT `supabase functions deploy <name>` (by anyone)
   ships the bare-specifier version resolved via `supabase/functions/deno.json`
   — a path now proven by `hybrid-custody-events` v12 (above), so this is
   low-risk, but still deploy one fn and confirm `ok:true` before a batch.
2. **`compute-topshot-pack-ev` was flagged "do-not-redeploy / byte-identical to
   prod" in CLAUDE.md** — its import line changed too, so it is no longer
   byte-identical. Treat its eventual redeploy with extra care (it is the
   flagship pack-EV money fn).

### `deno check` BASELINE — 24 real type errors (run 30502566358, 2026-07-30)

The refactor let `deno check` run fully; it found **24 type errors** in the edge
source (the layer nothing type-checked before — the gate is working). Fixing them
is edge-source work → **redeploy-aware**, and some touch off-limits money fns, so
it was NOT done autonomously from the sandbox. The list:

- **`snapshot-institutional-wallets/index.ts:290`** — `TS2304: Cannot find name
  'ids'`. **Genuine bug** (undefined var in an error-message path), version-
  independent. Fix first.
- **`sales-serial-backfill/index.ts:410,434`** — `TS2551: '.catch()' does not
  exist on PostgrestFilterBuilder`. **Genuine bug** — the `.catch(() => /*
  swallow */)` is on a query builder (a thenable, not a Promise), so the swallow
  never worked. Await it (or `.then(…, …)`), version-independent.
- **`compute-topshot-pack-ev/index.ts:579,600,883`** — `TS7022` implicit-any on
  `r`/`conn` (annotate the `gqlCall<…>` result) + `TS2322 'Timeout' not
  assignable to 'number'` (type the timer `ReturnType<typeof setTimeout>`).
  ⚠ flagship pack-EV money fn (CLAUDE.md "do-not-redeploy / byte-identical") —
  fix + redeploy with extra care.
- **`backfill-topshot-base-parallel-probe/index.ts:292,293`** — `TS2783/2785`
  spread overwrites `done` (`{...summary, done: …}` where `summary` already has
  `done`). Real code smell; reorder or omit.
- **`scan-pinnacle-wallet/index.ts:150`** — `TS2339: '.upsert' does not exist on
  SupabaseClient`. **Likely version-induced** — the jsr `@supabase/supabase-js@2`
  standardization pulled a newer `postgrest-js` (2.111.0) with stricter types.
  Before "fixing," pin the import map to the version the fn was written against
  (`@2.45.0`) to separate real bugs from version-strictness; then decide.

**Note on my version standardization:** mapping supabase-js → jsr `@2` (latest)
pulled newer, stricter SDK types than some fns' original inline pins. To get the
edge source's OWN type baseline (independent of the bump), a fixer may prefer to
pin the import map to a specific version first. This is why the gate stays
non-blocking until the 24 are triaged.

### What's left
- Fix the 24 `deno check` errors above (edge-source, redeploy-aware; start with
  the two genuine version-independent bugs), then remove `continue-on-error:
  true` from `edge-deno` to make `deno check` a blocking gate.
- The deploy verification above (operator; can't be done from a proxied sandbox,
  and auto-deploying 62 live money/ingest fns is off-limits).

---

## (original handoff, pre-refactor context — superseded by the UPDATE above)

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
