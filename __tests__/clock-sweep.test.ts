import { describe, it, expect } from "vitest"
import {
  DEFAULT_HOURS,
  offsetForUtcHour,
  failingIds,
  totalTests,
  classify,
  sweepExitCode,
  renderReport,
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

describe("the RPC_CLOCK_OFFSET_MS shim in vitest.setup.ts", () => {
  it("is inert in this process — the production suite must be unaffected", () => {
    // If the shim were active by default it would move every fixture written
    // against "now", and the suite would be measuring a lie.
    expect(process.env.RPC_CLOCK_OFFSET_MS ?? "0").toBe("0")
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

  it("is what vitest.setup.ts actually installs", () => {
    // The reconstruction above is only evidence if it matches the shipped code.
    const src = require("node:fs").readFileSync("vitest.setup.ts", "utf8")
    expect(src).toContain("RPC_CLOCK_OFFSET_MS")
    expect(src).toMatch(/if \(args\.length === 0\)/)
    expect(src).toMatch(/static now\(\)/)
  })
})
