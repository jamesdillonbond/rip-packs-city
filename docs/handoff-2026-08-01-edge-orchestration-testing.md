# Handoff — testing edge-function ORCHESTRATION bodies (needs a Deno toolchain)

**Author:** Claude Code, 2026-08-01 (interactive test-coverage pass).
**Status:** scoped, not started. Requires a session with a **Deno toolchain + edge deploy access** — this cloud sandbox has neither (jsr.io/esm.sh are proxy-blocked; no `deno` binary), so it could not be attempted here.
**Related:** [docs/handoff-2026-07-30-deno-edge-ci.md](handoff-2026-07-30-deno-edge-ci.md) (the `deno check` gate + the 16 remaining type errors). That handoff is about **type-checking** edge source; THIS one is about **behaviorally testing** it.

---

## Why this is the last real edge gap

Coverage is saturated everywhere a test can currently reach:

- Primary vitest gate (`lib/**` + `app/api/**/route.ts`) ~88% stmts; component gate ~74.5%.
- Every `_shared/*.ts` module is behaviorally unit-tested (26 modules) + drift-guarded against its inline edge copy.
- All 16 Cloudflare workers now drive their `fetch()`/`scheduled()` entry (2026-08-01 pass), enforced by the `worker-test-completeness` rot-guard.
- DB invariants: 66 SQL pins + drift guard.

What remains untested is the **orchestration body** of the Deno edge functions — the part that is NOT extractable as a pure helper: the `while`-cursor loops, the Flow-REST/GraphQL fan-outs, the retry/backoff, the batch-insert-with-fallback, and above all **the cursor-advance decision** (where "scanning ≠ writing" and "advance past a failed fetch = permanent silent data loss" live). This is the exact class that keeps biting in the session logs (the 2026-08-01 pack-opens-backfill scan-direction fix; the 2026-07-31 `scan-pinnacle-wallet` writing-nothing-since-June; the 2026-07-29 "cursor advances past a failed fetch → silent data loss" fixes across 4 Pinnacle fns).

**Pure logic is already extracted and tested; the loops around it are not.** `_shared/pack-opens-cursor.ts` and `_shared/spork-cursor.ts` pin the *cursor-advance decision functions*, but the runners that call them are unverified end-to-end.

`vitest` cannot reach this code: the edge fns import Deno globals + `Deno.serve` + JSR/esm.sh specifiers and are `exclude`d from the app tsconfig and from the coverage `include`. Testing them requires `deno test`.

---

## The two approaches (do #1; keep doing #2 alongside)

### 1. `deno test` files next to each edge fn — the real fix

Add `supabase/functions/<fn>/index_test.ts` files that import the fn's handler and drive it with a mocked `fetch` and a stubbed Supabase client, then run them with `deno test` in CI. No such file exists today (`find supabase/functions -name '*_test.ts'` → none).

Blockers to clear first (all in the Deno-session's wheelhouse, none doable from this sandbox):
- The edge handlers are not currently exported for test import in most fns (they `Deno.serve(async (req) => …)` inline). Extract the handler to an exported `export async function handler(req, deps)` where `deps` injects the Supabase client + `fetch` (dependency-injection seam), then `Deno.serve(handler)`. This IS an edge-source edit → **must be deploy-verified** (deploy one fn, confirm the next cron tick logs `ok:true` in `pipeline_runs`), which is why it needs deploy access.
- Wire a `deno test supabase/functions/**/*_test.ts` step. The `edge-deno` CI job already installs Deno (`.github/workflows/ci.yml`, `continue-on-error: true`); add a test step there, keep it non-blocking until green, then promote (same path `cadence-lint` followed).

### 2. Keep extracting the *decision points* to `_shared` (the sandbox-safe half)

Where a risky decision inside a loop can be expressed as a pure function, extract it to `_shared` + unit-test it + add a source-drift guard — the established pattern (`pack-opens-cursor.ts`, `spork-cursor.ts`, `nba-odds-parse.ts`, etc.). This is doable WITHOUT Deno or a redeploy (the edge fn keeps its inline copy; the guard ties them together) and already covers the highest-consequence decisions. It cannot cover the actual I/O sequencing — that needs #1.

---

## First targets, highest-consequence first (the silent-data-loss class)

These are cursored ingest/backfill fns where a wrong advance loses data invisibly. Each should get a `deno test` that asserts: **(a)** on an upstream fetch failure the cursor does NOT advance past the unscanned range, **(b)** a batch `.insert()` 23505 falls back to row-by-row (never drops co-batched new rows), **(c)** `dryRun`/budget-stop writes nothing and moves no cursor.

1. `ingest-topshot-pack-opens-history` — the 2026-08-01 descending-scan `scannedFloor` checkpoint fix; assert monotonic progress under a mid-window fetch failure (the bug that burned 96 runs/day).
2. `ingest-allday-pack-opens` — carries the identical scan-direction defect (repo-fixed 2026-08-01 but **not deployed**); assert the forward/`asc` vs backfill/`desc` split is byte-identical in forward mode.
3. `pinnacle-owner-discovery` / `pinnacle-owner-discovery-forward` / `hybrid-custody-events` — the 2026-07-29 "throw on non-OK Flow REST instead of returning [] (which looks like an empty window)" fix; assert a non-OK response HOLDS the cursor.
4. `sales-serial-backfill` `runSweep` — the serial-write gate (only overwrite NULL/0 with a positive int) end-to-end; `_shared/sales-serial-parse.ts` pins the predicate, but not the sweep's cursor/apply loop.
5. `snapshot-institutional-wallets` `runWork` — the 3-attempt retry + lock + the whale-holdings aggregation feeding `compute_institutional_wallet_diff`; `_shared/institutional-snapshot.ts` pins the aggregation, not the retry/lock orchestration.

Then the `compute-*-pack-ev` family (pure math already in `_shared/pack-ev-*`; the GraphQL fan-out + secondary-ask merge loops are untested).

---

## Guardrails for whoever picks this up

- **Deploy-verify every edge-source edit.** The repo source already diverges from deployed fns (inline `esm.sh` imports vs the `deno.json` import map — see the related handoff). A DI-seam refactor must be deployed one fn at a time, verified via the next cron `pipeline_runs` tick (`ok:true`), never by a manual curl (auth-gated + the auto-mode classifier blocks outbound gated calls).
- **Don't unify the two `unwrapCdc` variants.** The reduced CDC unwrapper in `sales-serial-backfill` / `backfill-allday-listing-serials` / `scan-ufc-wallet` deliberately omits the composite branches the full `_shared/cdc.ts` has — see `_shared/pinnacle-deposit-parse.ts` header.
- **The `deno test` step stays non-blocking** (`continue-on-error: true`) until a clean CI run, then drop the flag — same promotion path as `cadence-lint`/`edge-deno`.
- Keep the sandbox-safe extraction (#2) flowing in parallel; it needs neither Deno nor deploy and can be done in any session.

---

## What was NOT the gap (verified 2026-08-01, don't re-chase)

- Edge-fn **pure logic** is extracted + tested + drift-guarded: `nba-projections-parse`, `nba-odds-parse` (added this session), `pack-ev-edition` / `topshot-pack-ev-pricing` (incl. `editionExtKey`/`normalizeTier`/`computeDualPrice`), `topshot-stub-parse` (incl. `pickPlayerName`/`flattenCadenceDict`), `ufc-wallet-enrich` (incl. `inferTier`/`makeEditionKey`), `pack-distribution-parse`, `insider-detect`, `institutional-snapshot`, `sales-serial-parse`, the pinnacle mint/deposit/edition-key/wallet decoders, `pack-supply-parse`, `pack-opens-*`, `flow-address`, `cdc`/`cdc-reduced`, `atlas-pool-normalize`, `match-run-summary`, `hybrid-custody-parse`, `topshot-subedition-parse`. Adding more `_shared` copies of these would be theater.
