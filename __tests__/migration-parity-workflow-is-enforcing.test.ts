import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// The migration-parity job REPORTS NOTHING unless its exit code stands.
//
// ── WHY THIS IS A TEST AND NOT A COMMENT ───────────────────────────────────
// .github/workflows/migration-parity.yml shipped 2026-08-10 as warning-only,
// with the exit condition written into its own header: "TO MAKE IT ENFORCING
// once the backlog is cleared: delete the `|| true`". The backlog cleared and
// nobody re-checked — re-derived 2026-08-20, the 14-day figure was 5, not the
// 114 the comment still quoted. A decision-not-to-act recorded in prose is the
// one nobody revisits; the posture is now pinned here instead.
//
// ⚠ TWO THINGS MUST HOLD TOGETHER, and pinning only the first is worse than
// pinning neither. Every `run:` block is `bash -e`, so a bare failing pipeline
// aborts the step ON that line — deleting `|| true` alone would make the two
// grep annotations DEAD CODE, and they are what name WHICH migrations drifted.
// A job that fails without saying what failed trains people to re-run it. So
// this asserts the exit code stands AND that the status is captured rather than
// left to abort.
//
// ⚠ WHAT THIS DOES NOT CLAIM: nothing here proves the job finds real drift —
// that needs live credentials. It proves the FAILURE PATH is wired, which is
// the half that was silently missing. The shell semantics themselves were
// verified by simulation under `bash -e` for exit 0 / 1 / 2 before this landed.

const WF = join(process.cwd(), ".github", "workflows", "migration-parity.yml")

function workflow(): string {
  return readFileSync(WF, "utf8")
}

/** The body of the `run:` block that invokes the parity check. */
function checkStep(src: string): string {
  const i = src.indexOf("npm run db:migrations:check")
  expect(i, "the parity workflow no longer invokes db:migrations:check").toBeGreaterThan(-1)
  // From the start of that line to the end of the file is the whole tail of the
  // step — the last step in the job, so no further slicing is needed.
  return src.slice(src.lastIndexOf("\n", i) + 1)
}

describe("the migration-parity job fails when production is ahead of the repo", () => {
  it("the workflow still exists and still runs the check (not vacuously passing)", () => {
    const src = workflow()
    expect(src.length).toBeGreaterThan(1000)
    expect(src).toContain("npm run db:migrations:check")
    expect(src).toContain("MIGRATION_PARITY_WINDOW_DAYS")
  })

  it("does NOT swallow the check's exit code with `|| true`", () => {
    // This is the exact token the workflow's own header named as the thing to
    // delete. Its return would silently restore warning-only.
    expect(checkStep(workflow())).not.toMatch(/db:migrations:check[^\n]*\|\|\s*true/)
  })

  it("propagates the captured status as the step's exit code", () => {
    const step = checkStep(workflow())
    expect(step).toMatch(/\|\|\s*RC=\$\?/)
    expect(step).toMatch(/exit\s+"\$RC"/)
  })

  it("keeps both drift annotations reachable AFTER the failing command", () => {
    const step = checkStep(workflow())
    const npmAt = step.indexOf("npm run db:migrations:check")
    const driftAt = step.indexOf("applied to PRODUCTION with no committed file")
    const untrackedAt = step.indexOf("^UNTRACKED (")
    // Their POSITION is the assertion: under `bash -e` a grep placed before the
    // capture would run on a stale/absent log, and one placed after an aborting
    // command would never run at all.
    expect(driftAt).toBeGreaterThan(npmAt)
    expect(untrackedAt).toBeGreaterThan(npmAt)
    expect(step.indexOf('exit "$RC"')).toBeGreaterThan(untrackedAt)
  })

  it("treats 'the check could not run' as a failure, not a pass", () => {
    // Exit 2 is config/query error. Swallowing it would make an unreachable
    // database indistinguishable from a clean repo — the null-instrument shape.
    expect(checkStep(workflow())).toMatch(/RC"?\s*-eq\s*2/)
  })

  it("keeps the load-bearing 2>&1 so the drift lines reach the log at all", () => {
    // Every drift line is console.error. A bare pipe captures stdout only, which
    // is how these annotations went un-fired for their entire warning-only life.
    expect(checkStep(workflow())).toMatch(/db:migrations:check\s+2>&1\s*\|\s*tee/)
  })
})
