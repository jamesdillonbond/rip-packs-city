# Edge-function ↔ `_shared` convergence (deploy-gated handoff)

**Status:** READY TO APPLY — not applied, not deployed. Written 2026-07-12.

**Why this is a handoff and not a shipped change:** the pure logic behind the
event-ingest and pack-EV edge functions has been extracted into
vitest-tested modules under `supabase/functions/_shared/` (and `lib/`), but the
deployed edge functions still carry their own inline copies. Converging them
(edge fn imports the shared module, inline copy deleted) is behavior-preserving
*by construction* (the shared modules are verbatim ports), BUT:

1. There is **no Deno toolchain in this environment** (`deno.land` is blocked by
   the outbound proxy policy), so edge-function code cannot be type-checked or
   run here, and
2. `tsconfig.json` excludes `supabase/functions`, so `tsc` won't check it either.

Deploying an unverifiable change to the off-limits pack-EV / ingest functions is
exactly the invisible-failure class CLAUDE.md warns about (cf. the `maxDuration`
silent-ERROR incident). So the convergence is left as a ready diff for an
operator who HAS Deno + a deploy path to apply and verify.

The shared modules and their tests already merged and are green in vitest:
`supabase/functions/_shared/spork-cursor.ts` (+ `__tests__/edge-spork-cursor.test.ts`),
plus `_shared/pack-ev-edition.ts`, `_shared/cdc.ts` (+ their `__tests__/edge-*.test.ts`).
`lib/pack-ev-pricing.ts` holds `computeDualPrice` (already imported by
`app/api/pack-ev/route.ts`); the edge port is documented below.

---

## What imports what

| Edge function | Inline logic to replace | Shared module to import |
|---|---|---|
| `ingest-allday-pack-opens` | `reachableFloor`, `sporkFloorOf`, `isTransient` | `../_shared/spork-cursor.ts` |
| `ingest-topshot-pack-opens-history` | `reachableFloor`, `sporkFloorOf`, `isTransient` | `../_shared/spork-cursor.ts` |
| `snapshot-institutional-wallets` | `reachableFloor`/`sporkFloorOf`/`isTransient` (subset it uses) | `../_shared/spork-cursor.ts` |
| `compute-topshot-pack-ev` | `editionExtKey`, `normalizeTier` | `../_shared/pack-ev-edition.ts` |
| `compute-topshot-pack-ev` | `computeDualPrice` | see "pack-EV pricing" note below |

Deno imports require the explicit `.ts` extension and a relative path (the
`@/…` alias only exists for Next/vitest). Example for a spork-cursor consumer:

```ts
import { reachableFloor, sporkFloorOf, isTransient, type SporkConfig } from "../_shared/spork-cursor.ts"
```

### Signature note (spork-cursor)

The shared `reachableFloor(requested, cfg)` and `sporkFloorOf(h, cfg)` take a
`SporkConfig` object, whereas the inline copies close over module-level
constants. At each call site build the cfg once from the fn's existing
constants and pass it:

```ts
const SPORK_CFG: SporkConfig = {
  currentSporkMin: CURRENT_SPORK_MIN,
  sporkFloor: SPORK_FLOOR,
  sporkMaxHeights: SPORK_MAX_HEIGHTS,
  sporkAvailable: SPORK_AVAILABLE,
}
// then: reachableFloor(x, SPORK_CFG) / sporkFloorOf(h, SPORK_CFG)
```

`isTransient(status)` is unchanged (no config). Keep `CURRENT_SPORK_MIN`,
`SPORK_FLOOR`, `SPORK_MAX_HEIGHTS`, `SPORK_AVAILABLE` in the fn — they are still
used by `eventsFetch`/`txFetch` routing; only the three functions move out.

### pack-EV pricing note

`computeDualPrice` lives in `lib/pack-ev-pricing.ts` (Next path, not Deno-safe
to import from an edge fn). To converge `compute-topshot-pack-ev`, first mirror
it into `supabase/functions/_shared/pack-ev-pricing.ts` (identical body, no
imports — it's pure) and import THAT, so the edge fn and the Next route stay in
lockstep via two thin files with one source of truth in tests. Lower priority
than the spork-cursor convergence (pack-EV is on the off-limits list).

---

## Apply + verify checklist (operator, needs Deno + deploy access)

Do ONE function at a time, lowest-risk first
(`snapshot-institutional-wallets` → `ingest-topshot-pack-opens-history` →
`ingest-allday-pack-opens` → `compute-topshot-pack-ev` last):

1. **Edit** the fn: add the relative import, build the `SporkConfig` (spork
   consumers), delete the inline function bodies, leave constants in place.
2. **Type-check:** `deno check supabase/functions/<fn>/index.ts` — must be clean.
3. **Diff-audit:** confirm the only behavioral delta is "inline fn → imported fn
   with identical body". No logic edits.
4. **Branch deploy first** (never straight to prod): deploy to a Supabase branch
   / preview, invoke once with a known input, and confirm the output +
   `pipeline_runs` row match a pre-convergence run (same cursor advance, same
   row counts).
5. **Prod deploy** the single fn. Immediately check `pipeline_runs` for its
   pipeline on the next tick: `ok = true`, cursor advancing, no new error class
   in logs/Sentry for ~2 ticks.
6. **Rollback** if anything is off: `git revert` the wiring commit and redeploy
   the prior fn source (the inline-copy version). The shared modules can stay —
   they're inert until imported.

Only after a fn soaks clean for a few ticks, move to the next one.

---

## What NOT to do

- Do not batch-deploy all functions at once.
- Do not deploy `compute-topshot-pack-ev` until the three ingest fns have soaked
  — pack-EV route logic is off-limits for autonomous change and wants the most
  caution.
- Do not delete the shared modules if you roll back a wiring — they're the
  tested source of truth and harmless while unimported.
