import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * .github/workflows/workers-deploy.yml (push trigger added 2026-10-26) — two ways a push could leave a changed
 * worker undeployed with a green run, both found by review on 2026-10-27 before the trigger ever fired:
 *
 *  1. The concurrency group keeps ONE pending run, and a newer push CANCELS the older pending one. A run that
 *     diffed only its own push (`github.event.before`) dropped the cancelled push's workers. The diff base is
 *     now the last SUCCESSFUL push run of this workflow.
 *  2. The checkout is depth-1, so HEAD has no parent: `git diff-tree -r HEAD` (no --root) prints NOTHING and
 *     the old fallback skipped every worker. With --root it lists the whole tree (deploy everything).
 */

const wf = readFileSync(join(process.cwd(), ".github/workflows/workers-deploy.yml"), "utf8")
const run = wf.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n") // code, not comments

describe("workers-deploy push runs drop no worker", () => {
  it("the push diff base is the last successful push run, not only this push's `before`", () => {
    expect(run).toMatch(/gh run list[^\n]*--workflow workers-deploy\.yml/)
    expect(run).toMatch(/--event push --status success/)
    expect(run).toMatch(/actions: read/)
    expect(run).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/)
    // and the diff itself runs from that base
    expect(run).toMatch(/git diff --name-only "\$base" HEAD -- workers/)
  })

  it("the shallow-checkout fallback uses --root (without it a depth-1 HEAD lists nothing)", () => {
    const fallback = run.match(/git diff-tree[^\n]*/g) ?? []
    expect(fallback.length).toBeGreaterThan(0)
    for (const line of fallback) expect(line).toContain("--root")
  })

  it("CONTROL: the concurrency group still serialises deploys (never two wrangler runs at once)", () => {
    expect(wf).toMatch(/concurrency:\s*\n\s*group: workers-deploy\s*\n\s*cancel-in-progress: false/)
  })
})
