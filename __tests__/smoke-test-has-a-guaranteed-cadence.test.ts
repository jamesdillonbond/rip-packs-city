import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

// ⚠ WHY THIS GUARD EXISTS.
//
// `.github/workflows/smoke-tests.yml` triggered on `push: [main]` (now on the
// deploy's `deployment_status`) plus ONE daily schedule (12:11 UTC). So for most of the day the smoke suite's cadence was
// whatever the humans happened to be doing. Measured 2026-08-16 over a 7-day
// window of `support_conversations` smoke rows (the degradation check writes
// exactly one per tick, so they are a complete census of smoke runs):
//
//   day     ticks  hours covered (of 24)  largest gap
//   08-11    37          10                267 min
//   08-12    71          13                448 min
//   08-13    47          12                556 min  <- 9.3 HOURS
//   08-16   171          17                472 min
//
// EVERY day carried a 4.5-9.3 hour window with no smoke run at all. That is the
// same lesson `0807eb59` recorded one level down -- it made the live concierge
// probe deterministic after finding it fired only when some caller happened to
// tick inside a 09:00-09:24 UTC window -- but the fix was applied to the PROBE
// and not to the SUITE that carries it. An incidentally-scheduled check is not
// a monitor, for the same reason an optional one is not.
//
// The Vercel cron is the fix because this repo has already measured GitHub
// Actions silently dropping ~60-83% of scheduled ticks (see CLAUDE.md; two
// workflows were migrated to Vercel crons for exactly that reason).

const vercelJson = JSON.parse(readFileSync("vercel.json", "utf8")) as {
  crons: Array<{ path: string; schedule: string }>
}
const routeSrc = readFileSync("app/api/smoke-test/route.ts", "utf8")
const workflowSrc = readFileSync(".github/workflows/smoke-tests.yml", "utf8")

/** Expand the HOUR field of a 5-field cron expression. Supports `*`, `a,b`, `a-b`, `*\/n`. */
function cronHours(expr: string): number[] {
  const field = expr.trim().split(/\s+/)[1]
  const out = new Set<number>()
  for (const part of field.split(",")) {
    const [range, stepRaw] = part.split("/")
    const step = stepRaw ? Number(stepRaw) : 1
    let lo = 0
    let hi = 23
    if (range !== "*") {
      const [a, b] = range.split("-")
      lo = Number(a)
      hi = b === undefined ? Number(a) : Number(b)
    }
    for (let h = lo; h <= hi; h += step) out.add(h)
  }
  return [...out].sort((a, b) => a - b)
}

describe("the smoke suite has a guaranteed cadence, not a developer-driven one", () => {
  const smokeCrons = vercelJson.crons.filter((c) => c.path === "/api/smoke-test")

  it("wires exactly one Vercel cron at /api/smoke-test", () => {
    expect(smokeCrons).toHaveLength(1)
  })

  it("runs at least every 6 hours, so no blind window can reach the 9.3h measured", () => {
    const hours = cronHours(smokeCrons[0].schedule)
    expect(hours.length).toBeGreaterThanOrEqual(4)
    // largest wrap-around gap between consecutive runs
    const gaps = hours.map((h, i) =>
      i === 0 ? h + 24 - hours[hours.length - 1] : h - hours[i - 1],
    )
    expect(Math.max(...gaps)).toBeLessThanOrEqual(6)
  })

  // ⚠ THE COST PROPERTY. `wantsLiveConcierge()` returns true for ANY caller that
  // ticks inside 09:00-09:24 UTC, and a true there spends a real Anthropic call.
  // `0807eb59` deliberately reduced that probe to ~1/day (the GHA scheduled run).
  // Scheduling this cron into hour 9 would silently re-add a second paid probe
  // per day and undo that decision without anyone editing the concierge code.
  it("never ticks inside the 09:00-09:24 UTC live-concierge window", () => {
    expect(cronHours(smokeCrons[0].schedule)).not.toContain(9)
  })

  // Vercel crons issue GET. If someone drops the GET export the cron 405s every
  // tick -- and a 405 looks exactly like "never scheduled".
  it("keeps the GET export that Vercel cron actually calls", () => {
    expect(routeSrc).toMatch(/export async function GET\s*\(/)
  })

  // 2026-09-02: the workflow fires on `deployment_status` (Vercel's GitHub
  // Deployment reaching success), not on `push`. The push-time run slept 45 s
  // against a 110-124 s build and smoked the PREVIOUS deploy every time. The
  // cost property is unchanged: only the scheduled/dispatch run may spend a
  // paid concierge call, never a deploy-triggered one.
  it("leaves the GHA workflow as the one paid concierge caller, off for deploys", () => {
    expect(workflowSrc).toContain("?concierge=1")
    expect(workflowSrc).toMatch(/\[ "\$EVT" = "schedule" \] \|\| \[ "\$EVT" = "workflow_dispatch" \]/)
    expect(workflowSrc).toMatch(/^  deployment_status:/m)
    // A bare push trigger would smoke the previous deploy again.
    expect(workflowSrc).not.toMatch(/^  push:/m)
    expect(workflowSrc).not.toMatch(/run: sleep/)
  })

  // guards the guard: the hour parser must actually discriminate, or every
  // assertion above passes vacuously.
  it("parses cron hour fields correctly", () => {
    expect(cronHours("17 */4 * * *")).toEqual([0, 4, 8, 12, 16, 20])
    expect(cronHours("11 12 * * *")).toEqual([12])
    expect(cronHours("0 9 * * *")).toContain(9)
    expect(cronHours("0 8-10 * * *")).toContain(9)
    expect(cronHours("0 */3 * * *")).toContain(9)
  })
})
