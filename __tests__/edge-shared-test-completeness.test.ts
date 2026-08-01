import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

// ROT-GUARD for the edge-function shared-logic layer.
//
// The Deno edge functions (supabase/functions/**) run on Deno and are EXCLUDED
// from the vitest/tsc coverage measure — nothing gates their coverage. The repo
// pattern to make edge logic testable anyway is: extract the pure primitive into
// supabase/functions/_shared/<name>.ts, unit-test THAT module, and add a
// source-drift guard so the edge fn's inline copy can't diverge. (Most _shared
// modules are NOT imported by the edge index.ts — the deploy inlines the body,
// and the drift guard keeps the mirror honest. So "imported by an edge fn" is
// deliberately NOT the invariant here.)
//
// The hole that pattern leaves: someone extracts a NEW _shared module but never
// writes the test — it then sits in the tree looking "extracted" while measuring
// nothing, exactly the silent-rot class the component-gate completeness guard
// closes for components. This guard closes it for _shared: every _shared/*.ts
// module MUST be imported by at least one test file. Currently every one is, so
// this locks in that state and reds CI the moment a future extraction ships
// untested.

const ROOT = path.resolve(__dirname, "..")
const SHARED_DIR = path.join(ROOT, "supabase/functions/_shared")
const TESTS_DIR = path.join(ROOT, "__tests__")

// Shared modules deliberately shipped without a dedicated test import, each with
// a reason. Two-way (like the DB pin NOT_DEPLOYED_OK / RAW_FMV_DESC allowlists):
// an entry that IS imported by a test is stale and fails below, so the list
// can't rot silently. Currently EMPTY, deliberately — every _shared module is
// tested. Reserve this for a genuinely trivial re-export shim, not "I'll test it
// later".
const EXPECTED_UNTESTED: Record<string, string> = {}

/** All non-declaration source modules under _shared. */
function sharedModules(): string[] {
  return readdirSync(SHARED_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.endsWith(".test.ts"))
    .map((f) => f.replace(/\.ts$/, ""))
}

/** Concatenated text of every test file (so we can scan for import references). */
function allTestSources(): string {
  const parts: string[] = []
  const stack = [TESTS_DIR]
  while (stack.length) {
    const d = stack.pop()!
    for (const entry of readdirSync(d)) {
      const full = path.join(d, entry)
      if (statSync(full).isDirectory()) stack.push(full)
      else if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx"))
        parts.push(readFileSync(full, "utf8"))
    }
  }
  return parts.join("\n")
}

describe("edge _shared test completeness (rot-guard)", () => {
  const modules = sharedModules()
  const testSrc = allTestSources()

  // A module is "tested" if any test file references its _shared path. Both the
  // extensionless ("_shared/cdc") and explicit (".ts") forms count.
  const isTested = (m: string) =>
    testSrc.includes(`_shared/${m}"`) ||
    testSrc.includes(`_shared/${m}.ts"`) ||
    testSrc.includes(`_shared/${m}'`) ||
    testSrc.includes(`_shared/${m}.ts'`)

  it("finds real modules and real test sources (guard isn't inert)", () => {
    expect(modules.length).toBeGreaterThan(10)
    expect(testSrc.length).toBeGreaterThan(1000)
  })

  it("every _shared/*.ts module is imported by at least one test", () => {
    const untested = modules.filter((m) => !isTested(m) && !(m in EXPECTED_UNTESTED))
    expect(
      untested,
      `Extracted edge-shared module(s) [${untested.join(", ")}] are imported by NO ` +
        `test. The whole point of extracting to _shared is to make the logic ` +
        `testable — write a test (see any __tests__/edge-*.test.ts) or, only for a ` +
        `genuinely trivial shim, add it to EXPECTED_UNTESTED with a reason.`,
    ).toEqual([])
  })

  it("EXPECTED_UNTESTED has no stale entries (a now-tested module left in it)", () => {
    const stale = Object.keys(EXPECTED_UNTESTED).filter((m) => isTested(m))
    expect(
      stale,
      `Module(s) [${stale.join(", ")}] are in EXPECTED_UNTESTED but ARE imported by ` +
        `a test now — remove them from the allowlist.`,
    ).toEqual([])
  })

  it("EXPECTED_UNTESTED has no ghosts (entries for modules that no longer exist)", () => {
    const ghosts = Object.keys(EXPECTED_UNTESTED).filter((m) => !modules.includes(m))
    expect(
      ghosts,
      `EXPECTED_UNTESTED names module(s) [${ghosts.join(", ")}] that don't exist ` +
        `under supabase/functions/_shared — remove the stale entr(y/ies).`,
    ).toEqual([])
  })
})
