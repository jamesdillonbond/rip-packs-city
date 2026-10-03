import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { parse } from "yaml"
import { evaluate, rootAdvisories } from "../scripts/check-prod-dep-audit.mjs"

// ─────────────────────────────────────────────────────────────────────────────
// scripts/check-prod-dep-audit.mjs: a dependency change may not bring a NEW
// high/critical advisory into the production tree (2026-10-02; before it,
// nothing in CI read `npm audit`). Planted defects against synthetic reports,
// so this runs offline; the workflow runs the real audit.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, "..")
const ADV = (n: string) => `https://github.com/advisories/GHSA-test-${n}`

function report(vulns: Record<string, { severity: string; via: unknown[] }>, prod = 436) {
  return { vulnerabilities: vulns, metadata: { vulnerabilities: { high: 1 }, dependencies: { prod } } }
}
const advisory = (name: string, severity: string, n: string) => ({ name, severity, url: ADV(n), title: `${name} is bad`, source: 1 })

describe("check-prod-dep-audit — planted defects", () => {
  const baseline = { advisories: { [ADV("old")]: { package: "old-pkg", reason: "test" } } }

  it("passes when every high/critical root advisory is baselined", () => {
    const r = report({ "old-pkg": { severity: "high", via: [advisory("old-pkg", "high", "old")] } })
    expect(evaluate(r, baseline).exit).toBe(0)
  })

  it("reds on a NEW high advisory, and names the package and the advisory", () => {
    const r = report({
      "old-pkg": { severity: "high", via: [advisory("old-pkg", "high", "old")] },
      "new-pkg": { severity: "high", via: [advisory("new-pkg", "high", "new")] },
    })
    const { exit, lines } = evaluate(r, baseline)
    expect(exit).toBe(1)
    expect(lines.join("\n")).toContain("new-pkg")
    expect(lines.join("\n")).toContain(ADV("new"))
  })

  it("reds on a new CRITICAL, but ignores moderate and low", () => {
    const old = { "old-pkg": { severity: "high", via: [advisory("old-pkg", "high", "old")] } }
    expect(evaluate(report({ ...old, c: { severity: "critical", via: [advisory("c", "critical", "c")] } }), baseline).exit).toBe(1)
    expect(evaluate(report({ ...old, m: { severity: "moderate", via: [advisory("m", "moderate", "m")] } }), baseline).exit).toBe(0)
  })

  it("counts ROOT advisories, not the packages that only inherit one", () => {
    // tailwindcss -> chokidar -> braces: one advisory, three vulnerable packages.
    const r = report({
      braces: { severity: "high", via: [advisory("braces", "high", "braces")] },
      chokidar: { severity: "high", via: ["braces"] },
      tailwindcss: { severity: "high", via: ["chokidar"] },
    })
    expect([...rootAdvisories(r).keys()]).toEqual([ADV("braces")])
  })

  it("reds when a baselined advisory is no longer reported (the baseline only shrinks)", () => {
    const { exit, lines } = evaluate(report({}), baseline)
    expect(exit).toBe(1)
    expect(lines.join("\n")).toContain("NO LONGER REPORTED")
  })

  it("exits 2, never 0, when npm audit produced no readable report", () => {
    expect(evaluate(null, baseline).exit).toBe(2)
    expect(evaluate({ error: { code: "ENOAUDIT" } }, baseline).exit).toBe(2)
    // A report over a tree it did not read is not a clean bill either.
    expect(evaluate(report({}, 0), { advisories: {} }).exit).toBe(2)
  })
})

describe("the committed baseline and the workflow that runs it", () => {
  it("every baselined advisory carries a package and a reason", () => {
    const b = JSON.parse(readFileSync(path.join(ROOT, "prod-dep-audit-baseline.json"), "utf8"))
    const entries = Object.entries(b.advisories) as [string, { package?: string; reason?: string }][]
    expect(entries.length).toBeGreaterThan(0)
    for (const [url, e] of entries) {
      expect(url).toMatch(/^https:\/\/github\.com\/advisories\/GHSA-/)
      expect(e.package, url).toBeTruthy()
      expect((e.reason ?? "").length, `${url} needs a real reason`).toBeGreaterThan(30)
    }
  })

  it("dependency-audit.yml runs the gate on lockfile changes with no swallowed exit", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = parse(readFileSync(path.join(ROOT, ".github/workflows/dependency-audit.yml"), "utf8")) as any
    const paths: string[] = wf.on.push.paths
    expect(paths).toEqual(expect.arrayContaining(["package.json", "package-lock.json"]))
    expect(wf.on.pull_request.paths).toEqual(expect.arrayContaining(["package.json", "package-lock.json"]))
    const steps = Object.values(wf.jobs).flatMap((j) => (j as { steps: { run?: string; "continue-on-error"?: unknown }[] }).steps)
    const gate = steps.filter((s) => /check-prod-dep-audit\.mjs/.test(s.run ?? ""))
    expect(gate).toHaveLength(1)
    expect(gate[0].run).not.toMatch(/\|\|\s*true/)
    expect(gate[0]["continue-on-error"]).toBeFalsy()
  })
})
