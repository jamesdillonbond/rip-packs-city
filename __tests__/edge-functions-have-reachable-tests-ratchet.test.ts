import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs"
import path from "node:path"

// RATCHET: an edge function must have SOME behaviour a test can actually reach.
//
// ── WHY ────────────────────────────────────────────────────────────────────
// CI's `edge-deno` job runs `deno check` + an informational `deno lint`. There is
// NO Deno test run, so nothing inside a `supabase/functions/*/index.ts` is ever
// EXECUTED by a test. Behaviour is reachable in exactly two ways:
//
//   1. the function IMPORTS from `_shared`, which vitest can import directly; or
//   2. the function keeps an INLINE copy that is mirrored in `_shared` and pinned
//      byte-for-byte by __tests__/edge-inline-copy-drift-guard.test.ts — the
//      mirror is unit-tested, and the guard fails if the deployed copy diverges.
//
// ⚠ COUNTING ONLY (1) IS THE MISTAKE THIS FILE EXISTS TO AVOID, and I made it
// before measuring properly. The 2026-08-20 coverage analysis reported "32 of 38
// functions, 10,642 lines that no test can reach" from `imports _shared` alone.
// Pattern (2) is this repo's DOMINANT one — 22 functions use it versus 6 that
// import — so the real unreachable population is **10 functions / 1,767 lines**,
// about a sixth of the filed figure. A ratchet on the filed number would have
// pushed people to convert working mirrors into imports for no gain.
//
// ⚠ AND "HAS A MIRROR" IS ITSELF A PROXY, so do not read this as coverage. A
// mirror entry proves some symbol is pinned, not that the RISKY logic is:
// `compute-topshot-pack-ev` (1,584 lines) has mirror entries while
// edge-pack-ev-row-source-drift's own header says it "pins the EXPRESSIONS, not
// the behaviour". The honest claim is narrow — a function in the NEITHER bucket
// has definitively nothing reachable; one outside it has something.
//
// ⚠ Population from a TREE WALK; the mirrored set is DERIVED from the drift
// guard's registry, never restated here — two lists of the same thing drift.

const ROOT = path.resolve(__dirname, "..")
const FUNCTIONS_DIR = path.join(ROOT, "supabase", "functions")
const DRIFT_GUARD = path.join(ROOT, "__tests__", "edge-inline-copy-drift-guard.test.ts")

/** An import from `_shared`, in any relative spelling Deno accepts. */
export function importsShared(src: string): boolean {
  return /from\s+["'][^"']*_shared\//.test(src)
}

/**
 * Edge functions named by the drift guard's PINS registry — i.e. those whose
 * inline copy is pinned against a unit-tested `_shared` mirror.
 *
 * Rows are `[sharedModule, symbol, edgeFn, why]`; the edge fn is the THIRD
 * column. ⚠ Throws rather than returning empty on a parse miss: a silent zero
 * would move all 22 mirrored functions into the violation bucket and make this
 * ratchet's budget meaningless in the alarming direction.
 */
export function mirroredEdgeFns(src: string): Set<string> {
  const start = src.indexOf("const PINS: Array<[string, string, string, string]> = [")
  if (start < 0) throw new Error("drift-guard PINS registry not found — its shape changed")
  const end = src.indexOf("\n]", start)
  const rows = [...src.slice(start, end).matchAll(/\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"/g)]
  if (rows.length === 0) throw new Error("drift-guard PINS parsed to zero rows")
  return new Set(rows.map((m) => m[3]))
}

function edgeFunctions(): { name: string; src: string; lines: number }[] {
  const out: { name: string; src: string; lines: number }[] = []
  for (const entry of readdirSync(FUNCTIONS_DIR)) {
    if (entry === "_shared") continue
    const dir = path.join(FUNCTIONS_DIR, entry)
    if (!statSync(dir).isDirectory()) continue
    const idx = path.join(dir, "index.ts")
    if (!existsSync(idx)) continue
    const src = readFileSync(idx, "utf8")
    out.push({ name: entry, src, lines: src.split("\n").length })
  }
  return out.sort((a, b) => b.lines - a.lines)
}

function unreachable() {
  const mirrored = mirroredEdgeFns(readFileSync(DRIFT_GUARD, "utf8"))
  return edgeFunctions().filter((f) => !importsShared(f.src) && !mirrored.has(f.name))
}

// ⚠ RATCHET, NOT A TARGET. Lower it in the SAME commit that extracts or mirrors
// a function; never raise it. A NEW edge function shipping with nothing reachable
// pushes the count above the budget and reds CI — which is the point.
const BUDGET = 10

describe("edge functions have behaviour a test can reach", () => {
  it("the walk and the registry both found their populations (not vacuously passing)", () => {
    // ⚠ On the ENUMERATORS, never on the violation count — a not-vacuous check
    // must be satisfiable at zero violations, which is where this is headed.
    const fns = edgeFunctions()
    const mirrored = mirroredEdgeFns(readFileSync(DRIFT_GUARD, "utf8"))
    expect(fns.length, "the supabase/functions walk found nothing").toBeGreaterThan(20)
    expect(mirrored.size, "the drift-guard registry yielded no edge functions").toBeGreaterThan(10)
    expect(fns.some((f) => importsShared(f.src)), "no function imports _shared — the detector probably broke").toBe(true)
  })

  it("no more than the budgeted functions are wholly unreachable", () => {
    const bad = unreachable()
    const report = bad.map((f) => `${String(f.lines).padStart(5)}  ${f.name}`).join("\n")
    expect(
      bad.length,
      `BUDGET is ${BUDGET}; found ${bad.length}. Give the function reachable behaviour — either ` +
        `import from supabase/functions/_shared, or mirror the risky helper there and register the ` +
        `pair in edge-inline-copy-drift-guard — rather than raising this. If you fixed one, lower ` +
        `BUDGET in the same commit.\n${report}`,
    ).toBeLessThanOrEqual(BUDGET)
  })

  it("BUDGET is not stale — it tracks the real count, and only downward", () => {
    expect(BUDGET - unreachable().length, "BUDGET has drifted above the real count — lower it").toBeLessThanOrEqual(2)
  })

  // ── guards-the-guard ──────────────────────────────────────────────────────

  it("counts a MIRRORED function as reachable even though it imports nothing", () => {
    // The correction this file is built on. topshot-stub-resolver keeps inline
    // copies of flattenCadenceDict/pickPlayerName, imports no _shared — and both
    // are mirrored and unit-tested (18 cases in edge-topshot-stub-parse).
    // Counting it as unreachable is exactly the 6× overstatement above.
    const mirrored = mirroredEdgeFns(readFileSync(DRIFT_GUARD, "utf8"))
    expect(mirrored.has("topshot-stub-resolver")).toBe(true)
    expect(unreachable().map((f) => f.name)).not.toContain("topshot-stub-resolver")
  })

  it("detects the import in the spellings Deno uses, and a MENTION is not an import", () => {
    expect(importsShared(`import { x } from "../_shared/foo.ts"`)).toBe(true)
    expect(importsShared(`import {a,b} from '../_shared/bar.ts'`)).toBe(true)
    expect(importsShared(`import type { T } from "../../_shared/baz.ts"`)).toBe(true)
    expect(importsShared(`import { y } from "./local.ts"`)).toBe(false)
    // Several of these files discuss `_shared` in their headers; counting that
    // would mark them compliant for describing the thing they did not do.
    expect(importsShared(`// see ../_shared/pack-ev for the pinned copy`)).toBe(false)
    expect(importsShared(`// the 2026-07-20 _shared rewire refactored this`)).toBe(false)
  })

  it("fails LOUDLY if the drift-guard registry stops parsing", () => {
    // A silent empty set would move every mirrored function into the violation
    // bucket — the guard would break in the direction that looks like a finding.
    expect(() => mirroredEdgeFns("no registry here")).toThrow(/PINS registry not found/)
    expect(() =>
      mirroredEdgeFns(`const PINS: Array<[string, string, string, string]> = [\n]`),
    ).toThrow(/zero rows/)
  })
})
