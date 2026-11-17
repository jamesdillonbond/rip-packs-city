import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

// `npm run ci:guards` (scripts/run-ci-guards.mjs) exists so a local pass runs
// the same guards CI's TypeScript job runs. A hand-kept list beside the
// workflow goes stale silently (CLAUDE.md: a hardcoded allowlist beside a
// registry), so this pins the script's list to the workflow's `run:` steps —
// in both directions: a guard added to CI must be added here, a guard
// retired from CI must leave here.

const workflow = readFileSync(".github/workflows/ci.yml", "utf8")
const script = readFileSync("scripts/run-ci-guards.mjs", "utf8")

function guardsInWorkflow(): string[] {
  const out: string[] = []
  for (const m of workflow.matchAll(/^\s+- run: node scripts\/(check-[a-z0-9-]+)\.mjs\s*$/gm)) out.push(m[1])
  return out
}

function guardsInScript(): string[] {
  const block = /export const CI_GUARDS = \[([\s\S]*?)\]/.exec(script)
  if (!block) throw new Error("CI_GUARDS array not found")
  return Array.from(block[1].matchAll(/"(check-[a-z0-9-]+)"/g), m => m[1])
}

describe("scripts/run-ci-guards.mjs", () => {
  it("runs exactly the check-*.mjs guards the CI TypeScript job runs, in the workflow's order", () => {
    // The workflow also runs check-last-code-ci-on-main (a CI-only read of
    // GitHub's API) and check-memory-doc-links (the docs job); neither is a
    // tree guard a local pass can or should run.
    const ciOnly = new Set(["check-last-code-ci-on-main", "check-memory-doc-links"])
    const wf = guardsInWorkflow().filter(g => !ciOnly.has(g))
    expect(wf.length).toBeGreaterThanOrEqual(6)
    expect(guardsInScript()).toEqual(wf)
  })

  it("every listed guard is a file that exists", () => {
    for (const g of guardsInScript()) expect(() => readFileSync(`scripts/${g}.mjs`)).not.toThrow()
  })
})
