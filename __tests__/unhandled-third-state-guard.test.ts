import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// `scripts/check-unhandled-third-state.mjs` bans one syntactic way of having only
// TWO states where CLAUDE.md's honesty canon requires three:
//
//     if (error) { warn }  else if (data) { the real answer }   // and no else
//
// A read returning neither an error nor a payload then falls through and renders
// NOTHING. The measured instance was the sentinel's "FMV Confidence (canonical TS)"
// arm — the roadmap's headline accuracy metric — which did not warn, did not error
// and did not show zero: it VANISHED from the report. Absence in an alert reads as
// "not among today's problems", the unfalsifiable-alert class.
//
// ⚠ These tests pin the guard's CONTROLS as much as its detection. A detector that
// has quietly stopped matching prints "0 violations" and is indistinguishable from a
// clean tree, so the guard self-tests against a synthetic fixture before it reports,
// and must fail rather than pass when it inspected nothing.

const SCRIPT = path.resolve(__dirname, "../scripts/check-unhandled-third-state.mjs")
const REPO = path.resolve(__dirname, "..")

function run(root?: string): { code: number; out: string } {
  const args = root ? [SCRIPT, "--root", root] : [SCRIPT]
  try {
    const out = execFileSync(process.execPath, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    return { code: 0, out }
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }
  }
}

/** Build a fixture source tree: { "lib/x.ts": "<source>" }. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "thirdstate-"))
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  return dir
}

const TWO_BRANCH = `
export async function GET() {
  const { data, error } = await supabase.rpc("x")
  if (error) {
    checks.push({ status: "warn", detail: error.message })
  } else if (data) {
    checks.push({ status: "ok", detail: String(data) })
  }
}
`

const THREE_BRANCH = `
export async function GET() {
  const { data, error } = await supabase.rpc("x")
  if (error) {
    checks.push({ status: "warn", detail: error.message })
  } else if (data) {
    checks.push({ status: "ok", detail: String(data) })
  } else {
    checks.push({ status: "warn", detail: "RPC returned no payload — unreadable, not zero." })
  }
}
`

describe("unhandled-third-state guard", () => {
  it("flags the two-branch shape that made the accuracy arm disappear", () => {
    const r = run(fixture({ "app/api/a/route.ts": TWO_BRANCH }))
    expect(r.code).toBe(1)
    expect(r.out).toContain("else if(data) [no else]")
  })

  it("does NOT flag the corrected three-branch shape", () => {
    const r = run(fixture({ "app/api/a/route.ts": THREE_BRANCH }))
    expect(r.code).toBe(0)
  })

  // The guard must not fire on every else-if in the codebase — only on the ones
  // whose first branch is the error branch. A loading/ready split is not this bug.
  it("does NOT flag an else-if whose first condition is not an error", () => {
    const r = run(
      fixture({
        "lib/a.ts": `
          if (loading) { spinner() } else if (data) { render(data) }
        `,
      })
    )
    expect(r.code).toBe(0)
  })

  it("finds the shape in lib/ and components/, not just app/", () => {
    const inLib = run(fixture({ "lib/probe.ts": TWO_BRANCH }))
    const inComponents = run(fixture({ "components/Probe.tsx": TWO_BRANCH }))
    expect(inLib.code).toBe(1)
    expect(inComponents.code).toBe(1)
  })

  // CLAUDE.md: "a not-vacuous check must be satisfiable at a population of ZERO"
  // — but a run that inspected NOTHING is a different thing, and must never read
  // as a pass. That is the check-tree-corruption theatre ("0 file(s) checked, exit 0").
  it("cannot pass by inspecting nothing", () => {
    const r = run(fixture({ "README.md": "not source" }))
    expect(r.code).toBe(1)
    expect(r.out).toContain("inspected 0 files")
  })

  it("reports the count it actually inspected, so a pass is auditable", () => {
    const r = run(fixture({ "lib/a.ts": THREE_BRANCH }))
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/\d+ file\(s\) inspected/)
    expect(r.out).toContain("positive + negative controls passed")
  })

  it("is clean on the live repo, and inspected the whole tree to say so", () => {
    const r = run()
    expect(r.code).toBe(0)
    const n = Number(/(\d+) file\(s\) inspected/.exec(r.out)?.[1] ?? 0)
    expect(n).toBeGreaterThan(500)
  })

  // A guard nothing runs is theatre. CLAUDE.md: "Ask what RUNS a guard, not only
  // whether it passes" — check-tree-corruption.mjs had no CI job for months.
  it("is wired into CI", () => {
    const ci = readFileSync(path.join(REPO, ".github/workflows/ci.yml"), "utf8")
    expect(ci).toContain("check-unhandled-third-state.mjs")
  })
})
