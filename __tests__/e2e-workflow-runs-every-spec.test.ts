import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// COMPLETENESS: every `e2e/*.spec.ts` must be named in the workflow that runs
// the rendered-DOM monitor.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// `.github/workflows/e2e-smoke.yml` invokes Playwright with an EXPLICIT list of
// spec files rather than letting it discover `testDir`. That list is a curated
// list, and this repo has already paid for two of those: the smoke spec's own
// page list held 5 of 30 boards for weeks, and the component coverage gate's
// `include` silently excluded new files. **A spec that exists and never runs is
// indistinguishable from a spec that passes**, and the failure is silent in the
// worst possible place — the monitor nobody watches until something breaks.
//
// Adding `hydration-clock.spec.ts` (2026-08-27) is what surfaced it: nothing
// connected writing a new monitor spec to running it.
//
// ⚠ The assertion is SET-DIRECTIONAL on purpose: every discovered spec must be
// listed, but the list may name a spec that no longer exists only if someone
// deletes the file — which would red here and name the line to edit. It stays
// satisfiable when a spec is deleted AND delisted together.
const E2E_DIR = join(process.cwd(), "e2e")
const WORKFLOW = join(process.cwd(), ".github", "workflows", "e2e-smoke.yml")

export function specFiles(): string[] {
  return readdirSync(E2E_DIR)
    .filter((f) => f.endsWith(".spec.ts"))
    .sort()
}

// ⚠ EVERY invocation, not the first. Since 2026-10-12 the workflow has two
// jobs with their own `npx playwright test` lines (dom-smoke, and the
// non-blocking a11y-audit that runs e2e/a11y.spec.ts); reading only the first
// would have reported the a11y spec as unlisted — or, worse, let a spec listed
// ONLY in a later job go unseen if the first job's line were the one checked.
export function listedSpecs(yaml: string): Set<string> {
  const listed = new Set<string>()
  for (const run of yaml.matchAll(/npx playwright test ([^\n]*)/g)) {
    for (const t of run[1].split(/\s+/)) if (t.endsWith(".spec.ts")) listed.add(t)
  }
  return listed
}

describe("the e2e monitor workflow runs every spec that exists", () => {
  it("enumerates real spec files (not vacuously passing)", () => {
    // Asserts on the WALK, never on how many are missing — the check must stay
    // satisfiable when the answer is "none missing".
    expect(specFiles().length).toBeGreaterThan(3)
    expect(specFiles()).toContain("smoke.spec.ts")
  })

  it("every e2e spec is named in the workflow's playwright invocation", () => {
    const listed = listedSpecs(readFileSync(WORKFLOW, "utf8"))
    const missing = specFiles().filter((f) => !listed.has(f))
    expect(
      missing,
      `these e2e specs exist but the monitor never runs them — add them to the ` +
        `\`npx playwright test\` line in .github/workflows/e2e-smoke.yml: ${missing.join(", ")}`,
    ).toEqual([])
  })

  it("the parser reads the real invocation, and returns nothing when it cannot", () => {
    // Guards-the-guard: if the workflow is rewritten to a form this cannot
    // parse, the check above would report EVERY spec as missing (loud) rather
    // than none (silent). Pinned in both directions.
    expect(listedSpecs("run: npx playwright test a.spec.ts b.spec.ts").size).toBe(2)
    expect(listedSpecs("run: npm test").size).toBe(0)
    // Two jobs, two invocations: the union is what counts as "listed".
    expect(
      listedSpecs("run: npx playwright test a.spec.ts\n      run: npx playwright test c.spec.ts"),
    ).toEqual(new Set(["a.spec.ts", "c.spec.ts"]))
  })
})
