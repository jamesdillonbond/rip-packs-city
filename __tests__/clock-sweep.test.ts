import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import {
  DEFAULT_HOURS,
  offsetForUtcHour,
  failingIds,
  totalTests,
  classify,
  sweepExitCode,
  renderReport,
  fileSpawnsChildProcess,
  fileOfId,
} from "../scripts/clock-sweep.mjs"

// Register R67: three wall-clock-dependent tests in ONE day, by three authors,
// with at least two distinct mechanisms. A source scan cannot detect the class —
// `new Date()` is in hundreds of legitimate fixtures and a pattern aimed at one
// sub-shape misses the others — so the detector varies the ambient state and
// compares outcomes.
//
// What these tests protect is the CLASSIFICATION, because that is what makes the
// sweep safe to schedule. R67 filed the `sudo date -s` version and deliberately
// did not ship it: "if it reds for runner reasons rather than test reasons,
// revert". A failure that is not clock-dependent must never trip this.

const run = (hour: number, failing: string[], total = 100) => ({ hour, failing, total })

describe("offsetForUtcHour", () => {
  it("lands the process at HH:30 on the requested UTC hour", () => {
    const now = Date.parse("2026-08-30T02:00:00Z")
    for (const h of DEFAULT_HOURS) {
      const at = new Date(now + offsetForUtcHour(now, h))
      expect(at.getUTCHours()).toBe(h)
      expect(at.getUTCMinutes()).toBe(30)
    }
  })

  it("always moves the clock FORWARD, never back", () => {
    // ⚠ A backward offset would make an "expires tomorrow" fixture flip for the
    // wrong reason and read as a finding.
    const now = Date.parse("2026-08-30T23:00:00Z")
    expect(offsetForUtcHour(now, 0)).toBeGreaterThan(0)
    expect(offsetForUtcHour(now, 20)).toBeGreaterThan(0)
  })

  it("samples hours that no two of which agree under mod 6, 3 or 2", () => {
    // The sentinel defect was `getUTCHours() % 6 === 0`. An evenly spread sample
    // is exactly what such a predicate survives, so the spread is asserted.
    for (const m of [6, 3, 2]) {
      const remainders = DEFAULT_HOURS.map((h) => h % m)
      expect(new Set(remainders).size, `two sampled hours agree mod ${m}`).toBe(
        Math.min(DEFAULT_HOURS.length, m),
      )
    }
    // Hour 0 is load-bearing twice: it is the `% 6 === 0` branch AND the
    // early-UTC window where a date parsed as a datetime reads as elapsed.
    expect(DEFAULT_HOURS).toContain(0)
  })
})

describe("reading a vitest JSON report", () => {
  const report = {
    testResults: [
      {
        name: "/repo/__tests__/a.test.ts",
        assertionResults: [
          { fullName: "suite one", status: "passed" },
          { fullName: "suite two", status: "failed" },
        ],
      },
      { name: "/repo/__tests__/b.test.ts", assertionResults: [{ fullName: "suite three", status: "failed" }] },
    ],
  }

  it("collects the failing ids, file-qualified so two same-named tests do not merge", () => {
    expect(failingIds(report)).toEqual([
      "/repo/__tests__/a.test.ts > suite two",
      "/repo/__tests__/b.test.ts > suite three",
    ])
  })

  it("counts every test, which is the non-vacuity number", () => {
    expect(totalTests(report)).toBe(3)
  })

  it("returns an EMPTY list rather than throwing on a malformed report", () => {
    // The caller's non-vacuity check is what must catch this, not an exception —
    // an exception mid-sweep would discard the runs already completed.
    expect(failingIds({})).toEqual([])
    expect(totalTests(undefined)).toBe(0)
  })
})

describe("classify", () => {
  it("passes when the failing set is identical at every offset — including empty", () => {
    const r = classify([run(0, []), run(5, []), run(13, []), run(20, [])])
    expect(r.clockDependent).toEqual([])
    expect(sweepExitCode(r)).toBe(0)
  })

  it("REPORTS a test that fails at some offsets and passes at others, naming both", () => {
    const r = classify([run(0, []), run(5, ["t"]), run(13, ["t"]), run(20, ["t"])])
    expect(r.clockDependent).toEqual([{ id: "t", failedAt: [5, 13, 20], passedAt: [0] }])
    expect(sweepExitCode(r)).toBe(1)
  })

  it("does NOT report a test that fails at EVERY offset — that is not clock-dependence", () => {
    // ⚠ THE CONTROL THAT MAKES THIS SAFE TO SCHEDULE. A broken dependency, a bad
    // runner, or a genuinely failing test fails everywhere. Reporting it would
    // make the sweep a second, noisier copy of the unit-test job, and R67's own
    // falsifier says to revert an instrument that reds for its own reasons.
    const r = classify([run(0, ["t"]), run(5, ["t"]), run(13, ["t"]), run(20, ["t"])])
    expect(r.alwaysFailing).toEqual(["t"])
    expect(r.clockDependent).toEqual([])
    expect(sweepExitCode(r)).toBe(0)
  })

  it("separates the two in the SAME sweep — one always-failing, one clock-dependent", () => {
    const r = classify([run(0, ["broken"]), run(5, ["broken", "clocky"])])
    expect(r.alwaysFailing).toEqual(["broken"])
    expect(r.clockDependent.map((f) => f.id)).toEqual(["clocky"])
    expect(sweepExitCode(r)).toBe(1)
  })

  it("FAILS as vacuous on a single run — one set cannot differ from itself", () => {
    const r = classify([run(0, [])])
    expect(r.vacuous).toBe(true)
    expect(sweepExitCode(r)).toBe(2)
  })

  it("FAILS as vacuous when a run reported ZERO tests, rather than calling it clean", () => {
    // Comparing one empty set to another empty set looks exactly like a clean
    // pass. This is the defect class the whole register documents.
    const r = classify([run(0, [], 0), run(5, [], 100)])
    expect(r.vacuous).toBe(true)
    expect(sweepExitCode(r)).toBe(2)
  })
})

describe("renderReport", () => {
  it("names the hours a finding failed at and the hours it passed at", () => {
    const out = renderReport(classify([run(0, []), run(5, ["t"])]))
    expect(out).toContain("::error::WALL-CLOCK DEPENDENT")
    expect(out).toMatch(/failed at UTC hour\(s\) 5 and passed at 0/)
  })

  it("says plainly that an always-failing test is not this instrument's finding", () => {
    const out = renderReport(classify([run(0, ["t"]), run(5, ["t"])]))
    expect(out).toContain("NOT clock-dependent")
    expect(out).not.toContain("WALL-CLOCK DEPENDENT")
  })

  it("prescribes pinning the clock, not re-running — 'flake' is not a root cause", () => {
    const out = renderReport(classify([run(0, []), run(5, ["t"])]))
    expect(out).toMatch(/PINNING the clock/)
    expect(out).toMatch(/not by re-running/)
  })
})

describe("differences this instrument cannot speak to", () => {
  const spawns = (file: string) => file.endsWith("child.test.ts")

  it("does NOT report a differing test whose file spawns a child process", () => {
    // ⛔ Reporting it would make the sweep permanently red on a test that is
    // fine in CI — R67's own reason for declining the runner-clock version.
    const r = classify(
      [{ hour: 0, failing: ["/x/child.test.ts > t"], total: 10 }, { hour: 5, failing: [], total: 10 }],
      spawns,
    )
    expect(r.clockDependent).toEqual([])
    expect(r.outOfReach.map((f) => f.id)).toEqual(["/x/child.test.ts > t"])
    expect(sweepExitCode(r)).toBe(0)
  })

  it("STILL reports it, as unmeasured rather than clean, in the rendered output", () => {
    // The exclusion must not be silent: a child-process test COULD be genuinely
    // clock-dependent and this cannot tell.
    const out = renderReport(
      classify(
        [{ hour: 0, failing: ["/x/child.test.ts > t"], total: 10 }, { hour: 5, failing: [], total: 10 }],
        spawns,
      ),
    )
    expect(out).toContain("UNMEASURED")
    expect(out).toContain("not a clean bill either")
  })

  it("still reports a differing test whose file does NOT spawn a child", () => {
    // The control in the other direction: the exemption must be narrow.
    const r = classify(
      [{ hour: 0, failing: ["/x/plain.test.ts > t"], total: 10 }, { hour: 5, failing: [], total: 10 }],
      spawns,
    )
    expect(r.clockDependent.map((f) => f.id)).toEqual(["/x/plain.test.ts > t"])
    expect(sweepExitCode(r)).toBe(1)
  })

  it("puts every differing test in EXACTLY ONE bucket — the two must not overlap", () => {
    // ⚠ Added after a mutation survived: widening `outOfReach` to everything left
    // `clockDependent` untouched, so a finding could appear in both buckets and
    // be reported as a finding AND as unmeasured at once. The buckets are a
    // partition; assert that, not just each side.
    const runs = [
      { hour: 0, failing: ["/x/child.test.ts > a", "/x/plain.test.ts > b"], total: 10 },
      { hour: 5, failing: [], total: 10 },
    ]
    const r = classify(runs, spawns)
    const ids = [...r.clockDependent.map((f) => f.id), ...r.outOfReach.map((f) => f.id)].sort()
    expect(ids).toEqual(["/x/child.test.ts > a", "/x/plain.test.ts > b"])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("detects the spawn by PROPERTY, so a new shelling-out test needs no edit", () => {
    expect(fileSpawnsChildProcess('import { execFileSync } from "node:child_process"')).toBe(true)
    expect(fileSpawnsChildProcess('const { spawnSync } = require("child_process")')).toBe(true)
    expect(fileSpawnsChildProcess('import { describe } from "vitest"')).toBe(false)
  })

  it("takes the file from the id, so a test name containing ' > ' does not confuse it", () => {
    expect(fileOfId("/a/b.test.ts > suite > case")).toBe("/a/b.test.ts")
  })
})

describe("the RPC_CLOCK_OFFSET_MS shim in vitest.setup.ts", () => {
  it("agrees with the offset the environment declares, whatever that is", () => {
    // ⚠ THIS ASSERTION WAS WRONG ON ITS FIRST REAL USE and the sweep caught it.
    // It asserted `RPC_CLOCK_OFFSET_MS === "0"`, which is false BY CONSTRUCTION
    // while the sweep is running — so the detector reported one always-failing
    // test on every sweep. A permanently-noisy instrument is the exact outcome
    // R67 declined the runner-clock version to avoid, and I shipped it in the
    // replacement. The honest property holds under BOTH conditions: the process
    // clock must differ from the real clock by exactly the declared offset.
    const declared = Number(process.env.RPC_CLOCK_OFFSET_MS ?? "0")
    const drift = Date.now() - (globalThis.performance.timeOrigin + globalThis.performance.now())
    // Generous bound: this compares two clocks read microseconds apart, and
    // timeOrigin is itself sampled from the real clock at process start.
    expect(Math.abs(drift - declared)).toBeLessThan(5000)
  })

  it("shifts only the ZERO-ARGUMENT Date, leaving explicit instants alone", () => {
    // Asserted on a local reconstruction of the shim rather than by reactivating
    // it, because activating it inside a running suite would move the clock for
    // every other test file in this worker.
    const RealDate = Date
    const realNow = RealDate.now.bind(RealDate)
    const OFFSET = 3_600_000
    class Shifted extends RealDate {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(...args: any[]) {
        if (args.length === 0) super(realNow() + OFFSET)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        else super(...(args as [any]))
      }
      static now() {
        return realNow() + OFFSET
      }
    }
    const before = RealDate.now()
    expect(new Shifted().getTime() - before).toBeGreaterThanOrEqual(OFFSET - 1000)
    expect(Shifted.now() - before).toBeGreaterThanOrEqual(OFFSET - 1000)
    // The part that keeps the sweep from reporting the whole suite:
    expect(new Shifted("2020-01-02T03:04:05Z").toISOString()).toBe("2020-01-02T03:04:05.000Z")
    expect(new Shifted(0).toISOString()).toBe("1970-01-01T00:00:00.000Z")
  })

  it("cannot reach a CHILD process, which is why the sweep has a third bucket", () => {
    // A child is a fresh Node with the real clock. `find-future-dated-ledger-headings`
    // computes "today in Pacific" in the parent and runs the detector in a child,
    // so under a shifted parent the two disagree — at three of four offsets.
    // In CI they share one clock and it is not hour-dependent, so that difference
    // is an artifact of the instrument. Asserted here so the limitation is pinned
    // rather than remembered.
    const src = readFileSync("__tests__/find-future-dated-ledger-headings.test.ts", "utf8")
    expect(fileSpawnsChildProcess(src)).toBe(true)
  })

  it("is what vitest.setup.ts actually installs", () => {
    // The reconstruction above is only evidence if it matches the shipped code.
    const src = readFileSync("vitest.setup.ts", "utf8")
    expect(src).toContain("RPC_CLOCK_OFFSET_MS")
    expect(src).toMatch(/if \(args\.length === 0\)/)
    expect(src).toMatch(/static now\(\)/)
  })
})
