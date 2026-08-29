import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  firingsPerDay,
  scheduledWorkflows,
  classifyLiveness,
  livenessExitCode,
  fetchObserved,
  ApiError,
  MAX_SILENT_HOURS,
} from "@/scripts/check-scheduler-liveness.mjs"

// Guards the scheduler-liveness detector: the only check here that can see a
// workflow whose SCHEDULE stopped. A dropped tick produces no run, no badge and
// no email, so every other instrument reads clean — the workflow is `active`,
// its last run is `success`, and nothing says the alarm did not fire.

const ROOT = join(__dirname, "..")
const WORKFLOW_DIR = join(ROOT, ".github/workflows")
const NOW = Date.parse("2026-08-29T20:00:00Z")
const hoursAgo = (h: number) => new Date(NOW - h * 3600000).toISOString()

describe("cron expansion", () => {
  it("counts firings per day for every shape this repo actually uses", () => {
    expect(firingsPerDay("34 * * * *")).toBe(24)
    expect(firingsPerDay("13,43 * * * *")).toBe(48)
    expect(firingsPerDay("5,25,45 * * * *")).toBe(72)
    expect(firingsPerDay("41 */6 * * *")).toBe(4)
    expect(firingsPerDay("29 */3 * * *")).toBe(8)
    expect(firingsPerDay("45 2,8,14,20 * * *")).toBe(4)
    expect(firingsPerDay("40 6 * * *")).toBe(1)
  })

  it("returns null rather than a number it cannot justify", () => {
    // ⚠ null must NOT collapse to 0 anywhere downstream. A schedule the expander
    // cannot read is a CONFIG ERROR, and the caller escalates it — a `?? 0` here
    // would publish "expected 0 runs", which every workflow satisfies.
    expect(firingsPerDay("0 0 * * 1")).toBeNull() // day-of-week set
    expect(firingsPerDay("0 0 1 * *")).toBeNull() // day-of-month set
    expect(firingsPerDay("0 0 * 3 *")).toBeNull() // month set
    expect(firingsPerDay("not a cron")).toBeNull()
    expect(firingsPerDay("* * * *")).toBeNull() // 4 fields
    expect(firingsPerDay("99 * * * *")).toBeNull() // out of range
    expect(firingsPerDay("0 */0 * * *")).toBeNull() // zero step
  })
})

describe("the watchlist is a tree walk, not a curated list", () => {
  it("finds every workflow that declares a schedule, and no others", () => {
    // A curated list dies silently on a rename or misses the workflow added
    // yesterday. Derived from the tree, both are impossible — which is why this
    // asserts AGAINST the directory rather than against a fixed count.
    const found = new Set(scheduledWorkflows(WORKFLOW_DIR).map((w) => w.file))
    const expected = new Set(
      readdirSync(WORKFLOW_DIR)
        .filter((f) => /\.ya?ml$/.test(f))
        .filter((f) => {
          const code = readFileSync(join(WORKFLOW_DIR, f), "utf8")
            .split("\n")
            .map((l) => (/^\s*#/.test(l) ? "" : l.replace(/\s+#.*$/, "")))
            .join("\n")
          return /^\s*schedule:\s*$/m.test(code) && /^\s*-\s*cron:/m.test(code)
        }),
    )
    expect(found).toEqual(expected)
    expect(found.size).toBeGreaterThan(0)
  })

  it("every discovered cron is parseable — an unreadable one must never sit silent", () => {
    // Not a formality: this is the check that a new workflow using a shape the
    // expander cannot read becomes LOUD rather than invisible.
    for (const wf of scheduledWorkflows(WORKFLOW_DIR)) {
      for (const cron of wf.crons) {
        expect(firingsPerDay(cron), `${wf.file}: ${cron}`).not.toBeNull()
      }
    }
  })

  it("ignores a cron that appears only inside a comment", () => {
    // Several workflows here document alternative cadences in their headers. A
    // naive scan would register those as live schedules and then report them
    // permanently silent, which is a fabricated failure.
    const withCommentedCron = scheduledWorkflows(WORKFLOW_DIR).filter((w) =>
      readFileSync(join(WORKFLOW_DIR, w.file), "utf8")
        .split("\n")
        .some((l) => /^\s*#.*cron:/.test(l)),
    )
    for (const wf of withCommentedCron) {
      const live = readFileSync(join(WORKFLOW_DIR, wf.file), "utf8")
        .split("\n")
        .filter((l) => !/^\s*#/.test(l) && /^\s*-\s*cron:/.test(l)).length
      expect(wf.crons.length, wf.file).toBe(live)
    }
  })
})

describe("the liveness decision", () => {
  const wf = [{ path: ".github/workflows/x.yml", file: "x.yml", crons: ["34 * * * *"] }]

  it("passes a workflow that fired recently, however few times", () => {
    // ⛔ THE RATE IS REPORTED, NEVER FAILED ON. GitHub is currently shedding ~83%
    // of this repo's scheduled ticks; failing on the rate would make this
    // permanently red with no fix available in code, which is the exact class
    // this detector was written during an audit OF.
    const r = classifyLiveness({
      workflows: wf,
      observed: { "x.yml": { lastScheduledRunAt: hoursAgo(6), scheduledRuns: 4 } },
      now: NOW,
    })
    expect(r.dead).toHaveLength(0)
    expect(r.configErrors).toHaveLength(0)
    expect(livenessExitCode(r)).toBe(0)
    // ...but the shortfall is still carried out, as a number.
    expect(r.rows[0].observedInWindow).toBe(4)
    expect(r.rows[0].expectedInWindow).toBe(24)
  })

  it("fails a workflow silent past the bound", () => {
    const r = classifyLiveness({
      workflows: wf,
      observed: { "x.yml": { lastScheduledRunAt: hoursAgo(30), scheduledRuns: 0 } },
      now: NOW,
    })
    expect(r.dead.map((d) => d.file)).toEqual(["x.yml"])
    expect(livenessExitCode(r)).toBe(1)
  })

  it("fails a workflow that has never fired on schedule at all", () => {
    // A cron edited into a shape that never matches produces exactly this, and
    // is otherwise indistinguishable from a healthy quiet job.
    const r = classifyLiveness({
      workflows: wf,
      observed: { "x.yml": { lastScheduledRunAt: null, scheduledRuns: 0 } },
      now: NOW,
    })
    expect(r.dead).toHaveLength(1)
    expect(r.rows[0].silentHours).toBeNull()
    expect(livenessExitCode(r)).toBe(1)
  })

  it("clears the worst gap ever measured, so it is green on today's shedding", () => {
    // The bound is DERIVED: 24h against a measured maximum of 12.7h (Pipeline
    // Sentinel, 2026-08-29, contiguous pages). A guard that is red on day one
    // with no code fix available teaches people to ignore it.
    expect(MAX_SILENT_HOURS).toBeGreaterThan(12.7 * 1.5)
    const r = classifyLiveness({
      workflows: wf,
      observed: { "x.yml": { lastScheduledRunAt: hoursAgo(12.7), scheduledRuns: 2 } },
      now: NOW,
    })
    expect(r.dead).toHaveLength(0)
  })

  it("escalates a workflow the API knows nothing about — a rename must not read as a pass", () => {
    // The failure mode that kills guards in this repo: the watched thing is
    // renamed, the guard inspects nothing, and it exits 0 looking healthy.
    const r = classifyLiveness({ workflows: wf, observed: {}, now: NOW })
    expect(r.configErrors).toHaveLength(1)
    expect(r.configErrors[0]).toMatch(/x\.yml/)
    expect(r.rows).toHaveLength(0)
    expect(livenessExitCode(r)).toBe(2)
  })

  it("escalates an unparseable cron instead of scoring it zero", () => {
    const r = classifyLiveness({
      workflows: [{ path: "p", file: "y.yml", crons: ["0 0 * * 1"] }],
      observed: { "y.yml": { lastScheduledRunAt: hoursAgo(1), scheduledRuns: 1 } },
      now: NOW,
    })
    expect(r.configErrors).toHaveLength(1)
    expect(livenessExitCode(r)).toBe(2)
  })

  it("excludes ITSELF, because a detector cannot witness its own silence", () => {
    // Both directions of including it are wrong: if this workflow stops it never
    // runs, so it can never report itself dead; and before its first scheduled
    // tick a manual dispatch sees zero scheduled runs and manufactures a
    // failure. Excluded by identity — the running workflow's own file — not by
    // matching a name string, which a rename would break.
    const self = { path: "p", file: "scheduler-liveness.yml", crons: ["17 8 * * *"] }
    const other = { path: "p", file: "x.yml", crons: ["34 * * * *"] }

    const withoutSelf = classifyLiveness({
      workflows: [self, other],
      observed: {
        "x.yml": { lastScheduledRunAt: hoursAgo(2), scheduledRuns: 10 },
        // self deliberately absent — the first-dispatch state
      },
      now: NOW,
      selfFile: "scheduler-liveness.yml",
    })
    expect(withoutSelf.configErrors).toHaveLength(0)
    expect(withoutSelf.rows.map((r) => r.file)).toEqual(["x.yml"])
    expect(livenessExitCode(withoutSelf)).toBe(0)

    // Negative control: without the exclusion the SAME input fails, so the
    // exclusion is doing work rather than decorating the signature.
    const withSelf = classifyLiveness({
      workflows: [self, other],
      observed: { "x.yml": { lastScheduledRunAt: hoursAgo(2), scheduledRuns: 10 } },
      now: NOW,
    })
    expect(livenessExitCode(withSelf)).toBe(2)
  })

  it("the exclusion is exactly one workflow, never a prefix or a wildcard", () => {
    // An exclusion stated too broadly is how a guard quietly stops watching the
    // thing it was written for.
    const a = { path: "p", file: "scheduler-liveness.yml", crons: ["17 8 * * *"] }
    const b = { path: "p", file: "scheduler-liveness-extra.yml", crons: ["34 * * * *"] }
    const r = classifyLiveness({
      workflows: [a, b],
      observed: { "scheduler-liveness-extra.yml": { lastScheduledRunAt: hoursAgo(1), scheduledRuns: 20 } },
      now: NOW,
      selfFile: "scheduler-liveness.yml",
    })
    expect(r.rows.map((x) => x.file)).toEqual(["scheduler-liveness-extra.yml"])
  })

  it("a config error outranks a clean sweep", () => {
    // Positive control on the exit code: without this, a body that returns 0
    // whenever `dead` is empty would satisfy every other case here.
    expect(livenessExitCode({ dead: [], configErrors: ["boom"] })).toBe(2)
    expect(livenessExitCode({ dead: [{}], configErrors: [] })).toBe(1)
    expect(livenessExitCode({ dead: [], configErrors: [] })).toBe(0)
  })
})

describe("the HTTP layer", () => {
  const wf = [{ path: "p", file: "x.yml", crons: ["34 * * * *"] }]
  const ok = (runs: string[]) => ({
    ok: true,
    status: 200,
    json: async () => ({ workflow_runs: runs.map((t) => ({ created_at: t })) }),
  })

  it("reads the newest scheduled run out of the window response", async () => {
    const observed = await fetchObserved({
      repo: "o/r",
      token: "t",
      workflows: wf,
      since: hoursAgo(24),
      fetchImpl: async () => ok([hoursAgo(9), hoursAgo(2), hoursAgo(15)]) as never,
    })
    expect(observed["x.yml"].scheduledRuns).toBe(3)
    // Sorted, not "whatever the API listed first" — the API returns newest-first
    // and an unordered read would report the wrong last-run time.
    expect(observed["x.yml"].lastScheduledRunAt).toBe(hoursAgo(2))
  })

  it("falls back to a separate probe when the window is empty, so 40h silent is not read as 24h", async () => {
    let calls = 0
    const observed = await fetchObserved({
      repo: "o/r",
      token: "t",
      workflows: wf,
      since: hoursAgo(24),
      fetchImpl: async () => {
        calls += 1
        return (calls === 1 ? ok([]) : ok([hoursAgo(40)])) as never
      },
    })
    expect(calls).toBe(2)
    expect(observed["x.yml"]).toEqual({ lastScheduledRunAt: hoursAgo(40), scheduledRuns: 0 })
  })

  it("THROWS on a non-2xx rather than reporting nothing to report", async () => {
    // The property that matters. A guard that swallows a 500 and exits 0 has
    // published an all-clear it did not earn — the defect class this whole audit
    // is about.
    await expect(
      fetchObserved({
        repo: "o/r",
        token: "t",
        workflows: wf,
        since: hoursAgo(24),
        fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) as never,
      }),
    ).rejects.toBeInstanceOf(ApiError)
  })

  it("leaves a 404 ABSENT so the caller escalates it as the rename it is", async () => {
    const observed = await fetchObserved({
      repo: "o/r",
      token: "t",
      workflows: wf,
      since: hoursAgo(24),
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) as never,
    })
    expect(observed["x.yml"]).toBeUndefined()
    // ...and the caller does escalate it, rather than skipping quietly.
    const r = classifyLiveness({ workflows: wf, observed, now: NOW })
    expect(livenessExitCode(r)).toBe(2)
  })

  it("never queries its own history", async () => {
    const urls: string[] = []
    await fetchObserved({
      repo: "o/r",
      token: "t",
      workflows: [{ path: "p", file: "scheduler-liveness.yml", crons: ["17 8 * * *"] }, ...wf],
      since: hoursAgo(24),
      selfFile: "scheduler-liveness.yml",
      fetchImpl: async (u: string) => {
        urls.push(u)
        return ok([hoursAgo(1)]) as never
      },
    })
    expect(urls.some((u) => u.includes("scheduler-liveness.yml"))).toBe(false)
    expect(urls.some((u) => u.includes("x.yml"))).toBe(true)
  })
})
