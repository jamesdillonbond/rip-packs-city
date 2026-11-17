import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { parse } from "yaml"

// ─────────────────────────────────────────────────────────────────────────────
// THE EDGE AUTH-GATE SUITE IS A DENO TEST, SO VITEST CANNOT RUN IT — AND A TEST
// NOTHING RUNS IS NOT A GATE.
//
// supabase/functions/_tests/auth_gate_test.ts proves every edge function refuses
// an anonymous caller before touching the database (all are verify_jwt=false,
// so that check is their only gate). It runs in ci.yml's `edge-deno` job and
// nowhere else. If that step is deleted, renamed out of the job, or loses
// `--allow-read`/`--allow-env` (it then dies at its first import, and a step
// someone "fixes" with `|| true` passes forever), nothing else would notice.
// This pins the invocation; the Deno suite owns the property.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, "..")
const SUITE = "supabase/functions/_tests/auth_gate_test.ts"

describe("the edge auth-gate Deno suite runs in CI", () => {
  it("exists where the CI step points", () => {
    expect(existsSync(path.join(ROOT, SUITE))).toBe(true)
    expect(existsSync(path.join(ROOT, "supabase/functions/_tests/deno.json"))).toBe(true)
  })

  it("edge-deno runs `deno test` on it with its own config and no swallowed exit", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = parse(readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, any> }
    const job = wf.jobs["edge-deno"]
    expect(job, "ci.yml has no edge-deno job").toBeTruthy()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steps: { run?: string; "continue-on-error"?: unknown }[] = job.steps.filter((s: any) => /\bdeno test\b/.test(s.run ?? ""))
    expect(steps).toHaveLength(1)
    const run = steps[0].run!
    expect(run).toContain("--config supabase/functions/_tests/deno.json")
    expect(run).toContain("supabase/functions/_tests/")
    expect(run).toMatch(/--allow-read\b/)
    expect(run).toMatch(/--allow-env\b/)
    // Never network: the suite's stubs are what make a db call or fetch visible.
    expect(run).not.toMatch(/--allow-net|--allow-all|\s-A\b/)
    expect(run, "a swallowed exit makes the suite decorative").not.toMatch(/\|\|\s*true/)
    expect(steps[0]["continue-on-error"]).toBeFalsy()
  })

  it("is not mistaken for a deployable function (no index.ts in _tests)", () => {
    // Every function walker (edge-fn-drift, the gate-key test, the reachable-
    // tests ratchet) keys on <dir>/index.ts; _tests must never have one.
    expect(existsSync(path.join(ROOT, "supabase/functions/_tests/index.ts"))).toBe(false)
  })
})
