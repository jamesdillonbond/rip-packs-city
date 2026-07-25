import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Source-contract pin for the Smoke Tests CI gate.
//
// The gate in .github/workflows/smoke-tests.yml previously read a `failed` key
// that app/api/smoke-test/route.ts has never returned; python's
// `d.get('failed', 0)` quietly produced 0, so the failure branch was dead code
// and the workflow was green on ~3,072 runs regardless of results (while a real
// `rpc:check_public_security_invariants` hard failure was live).
//
// These assertions make that class of silent detachment a CI failure: every key
// scripts/smoke-gate.py declares in REQUIRED_KEYS must exist in the route's
// success response literal, and the response literal must keep emitting the
// hard/soft split the gate depends on. There is no mock seam that lets us call
// the real handler (it fires dozens of live HTTP probes — see
// __tests__/api-smoke-test.test.ts), so this is a source-level guard, matching
// the repo's other drift guards.

const ROOT = join(__dirname, "..")
const ROUTE_SRC = readFileSync(join(ROOT, "app/api/smoke-test/route.ts"), "utf8")
const GATE_SRC = readFileSync(join(ROOT, "scripts/smoke-gate.py"), "utf8")
const WORKFLOW_SRC = readFileSync(join(ROOT, ".github/workflows/smoke-tests.yml"), "utf8")

/** Keys listed in the gate's REQUIRED_KEYS tuple. */
function gateRequiredKeys(): string[] {
  const m = GATE_SRC.match(/REQUIRED_KEYS\s*=\s*\(([^)]*)\)/)
  expect(m, "scripts/smoke-gate.py must declare a REQUIRED_KEYS tuple").toBeTruthy()
  return Array.from((m as RegExpMatchArray)[1].matchAll(/"([^"]+)"/g)).map((x) => x[1])
}

/** Keys in the route's success `NextResponse.json({ ... })` payload. */
function routeResponseKeys(): string[] {
  const i = ROUTE_SRC.indexOf("return NextResponse.json({")
  expect(i, "route must return NextResponse.json({ ... })").toBeGreaterThan(-1)
  const block = ROUTE_SRC.slice(i, i + 600)
  return Array.from(block.matchAll(/^\s{4}([A-Za-z_][A-Za-z0-9_]*)\s*[,:]/gm)).map((x) => x[1])
}

describe("smoke-test CI gate contract", () => {
  it("the route's success response carries every key the gate requires", () => {
    const required = gateRequiredKeys()
    const emitted = routeResponseKeys()
    expect(required.length).toBeGreaterThan(0)
    for (const key of required) {
      expect(emitted, `smoke-test response must emit "${key}" (scripts/smoke-gate.py reads it)`).toContain(key)
    }
  })

  it("the gate requires the hard/soft split, not a nonexistent `failed` key", () => {
    const required = gateRequiredKeys()
    expect(required).toContain("hardPassed")
    expect(required).toContain("hardTotal")
    expect(required).toContain("results")
    // `failed` is the key that made the old gate dead code — the route does not
    // emit it, so requiring it would fail every run instead of passing every run.
    expect(required).not.toContain("failed")
    expect(routeResponseKeys()).not.toContain("failed")
  })

  it("the gate fails when an expected key is absent (no silent pass)", () => {
    expect(GATE_SRC).toMatch(/missing/)
    expect(GATE_SRC).toMatch(/hard_passed\s*!=\s*hard_total/)
    // No python `.get(key, default)` on a gate-critical key — that default is
    // exactly what turned the old check into a no-op.
    for (const key of gateRequiredKeys()) {
      expect(GATE_SRC).not.toContain(`.get("${key}", 0)`)
    }
  })

  it("the workflow invokes the gate script and checks out the repo to reach it", () => {
    expect(WORKFLOW_SRC).toContain("scripts/smoke-gate.py")
    expect(WORKFLOW_SRC).toContain("actions/checkout")
    // The retired inline check must not come back.
    expect(WORKFLOW_SRC).not.toContain("d.get('failed'")
  })

  it("the route still returns the soft-failure counter the gate reports", () => {
    expect(routeResponseKeys()).toContain("softFailures")
  })
})
