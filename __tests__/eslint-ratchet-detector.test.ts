import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  countByRule,
  compareToBaseline,
  ratchetExitCode,
  findStaleness,
  BASELINE_PATH,
} from "@/scripts/check-eslint-ratchet.mjs"

// Guards the eslint ratchet. Raw eslint is not a CI gate here; measured
// 2026-08-29 that is a RULE-SET MISMATCH rather than neglect — 6,474 violations,
// 5,757 of them `no-explicit-any`, which is a documented convention here. The
// ratchet bounds the remaining 717 so they can only shrink.
//
// ⚠ The ratchet IS a blocking CI job ("ESLint ratchet"), and it runs eslint
// itself before comparing:
//     npx eslint . --format json -o /tmp/eslint-report.json || true
//     node scripts/check-eslint-ratchet.mjs --report /tmp/eslint-report.json
// The comparison script alone measures NOTHING — it reads whatever JSON is at
// that path. That is not a detail: `npm run lint:ratchet` used to be the second
// line only, so it happily read a report from hours earlier and printed
// "717 = baseline" across four consecutive pushes that CI failed.

const ROOT = join(__dirname, "..")
const baseline = JSON.parse(readFileSync(join(ROOT, BASELINE_PATH), "utf8"))

const report = (msgs: { ruleId: string | null }[][]) =>
  msgs.map((messages) => ({ filePath: "f", messages }))

describe("counting", () => {
  it("counts per rule and honours the exclusions", () => {
    const { counts } = countByRule(
      report([[{ ruleId: "a" }, { ruleId: "a" }, { ruleId: "skipme" }], [{ ruleId: "b" }]]),
      ["skipme"],
    )
    expect(counts).toEqual({ a: 2, b: 1 })
  })

  it("treats a null ruleId as an unused eslint-disable, NOT as a parse failure", () => {
    // My first reading of this report classified these as files eslint could not
    // parse, which would have been a much more alarming finding than it is.
    const { counts, suppressionsWithNothingToSuppress } = countByRule(
      report([[{ ruleId: null }, { ruleId: "a" }]]),
      [],
    )
    expect(counts).toEqual({ a: 1 })
    expect(suppressionsWithNothingToSuppress).toBe(1)
  })
})

describe("the ratchet decision", () => {
  const base = { a: 5, b: 2 }

  it("passes when counts hold or shrink", () => {
    expect(compareToBaseline({ counts: { a: 5, b: 2 }, baseline: base }).ok).toBe(true)
    expect(compareToBaseline({ counts: { a: 1, b: 2 }, baseline: base }).ok).toBe(true)
  })

  it("fails when a known rule grows", () => {
    const r = compareToBaseline({ counts: { a: 6, b: 2 }, baseline: base })
    expect(r.ok).toBe(false)
    expect(r.grew).toEqual([{ rule: "a", was: 5, now: 6 }])
  })

  it("fails when a rule NOT in the baseline appears", () => {
    // The blindness mode that matters: an unmeasured rule is not a pass. Without
    // this, enabling a new rule — or a plugin upgrade adding one — lands
    // silently and the ratchet quietly stops covering it.
    const r = compareToBaseline({ counts: { a: 5, b: 2, c: 1 }, baseline: base })
    expect(r.ok).toBe(false)
    expect(r.appeared).toEqual([{ rule: "c", now: 1 }])
  })

  it("reports a rule that reached zero so the baseline cannot describe the past", () => {
    const r = compareToBaseline({ counts: { a: 5 }, baseline: base })
    expect(r.ok).toBe(true) // shrinking never fails the build...
    expect(r.emptied).toEqual([{ rule: "b", was: 2 }]) // ...but it is surfaced
  })
})

describe("the exit code", () => {
  it("distinguishes 'eslint found nothing' from 'eslint did not run'", () => {
    // The two produce the same zero, and only one of them is good news.
    expect(ratchetExitCode({ ok: true, ran: true })).toBe(0)
    expect(ratchetExitCode({ ok: false, ran: true })).toBe(1)
    expect(ratchetExitCode({ ok: true, ran: false })).toBe(2)
  })
})

describe("the committed baseline", () => {
  it("excludes no-explicit-any at the RULE's granularity, not the plugin's", () => {
    // Muting @typescript-eslint wholesale would also silence
    // no-unused-expressions, no-require-imports and no-empty-object-type, which
    // are not conventional here and are in the baseline precisely so they stay
    // bounded.
    expect(baseline.excludedRules).toEqual(["@typescript-eslint/no-explicit-any"])
    const ruleNames = Object.keys(baseline.counts)
    expect(ruleNames).not.toContain("@typescript-eslint/no-explicit-any")
    expect(ruleNames.filter((r) => r.startsWith("@typescript-eslint/")).length).toBeGreaterThan(1)
  })

  it("is not vacuous — it bounds real rules, including correctness ones", () => {
    // A baseline of only style rules would pass forever while the classes that
    // actually break a page went unbounded.
    const names = Object.keys(baseline.counts)
    expect(names.length).toBeGreaterThan(10)
    expect(names).toContain("react-hooks/set-state-in-effect")
    expect(names).toContain("@next/next/no-html-link-for-pages")
    for (const n of Object.values(baseline.counts)) expect(n).toBeGreaterThan(0)
  })
})

describe("staleness — a complete, parseable report of the WRONG TREE", () => {
  // 🚨 THE REAL INCIDENT, 2026-09-02. The script already refuses a report that is
  // missing, unparseable or empty. None of those catches a report that is
  // complete and simply OLD. `npm run lint:ratchet` invoked the comparison alone
  // against a fixed /tmp path, so a report left by an earlier run was read as a
  // measurement of the current one: it printed "717 = baseline" four times while
  // CI, which regenerates the report first, saw 719 and failed every push.
  //
  // A green local instrument and a red CI job, out of the same script. The npm
  // script now generates the report itself, and this check makes the divergence
  // impossible to reproduce silently.

  const REPORT_AT = 1_000_000

  it("returns null when every linted file predates the report", () => {
    expect(
      findStaleness({
        reportMtimeMs: REPORT_AT,
        linted: [
          { path: "a.ts", mtimeMs: REPORT_AT - 5_000 },
          { path: "b.ts", mtimeMs: REPORT_AT - 1 },
        ],
      }),
    ).toBeNull()
  })

  it("flags a file modified after the report, and names it", () => {
    const stale = findStaleness({
      reportMtimeMs: REPORT_AT,
      linted: [
        { path: "old.ts", mtimeMs: REPORT_AT - 5_000 },
        { path: "edited.ts", mtimeMs: REPORT_AT + 30_000 },
      ],
    })
    expect(stale?.path).toBe("edited.ts")
    expect(stale?.laterByMs).toBe(30_000)
  })

  it("names the WORST offender when several files are newer", () => {
    // The one furthest ahead is the most convincing evidence the tree moved.
    const stale = findStaleness({
      reportMtimeMs: REPORT_AT,
      linted: [
        { path: "a.ts", mtimeMs: REPORT_AT + 2_000 },
        { path: "b.ts", mtimeMs: REPORT_AT + 90_000 },
        { path: "c.ts", mtimeMs: REPORT_AT + 5_000 },
      ],
    })
    expect(stale?.path).toBe("b.ts")
  })

  it("tolerates coarse mtimes inside the slack window", () => {
    // Checkout steps and some filesystems stamp whole seconds; a 1s tolerance
    // must not turn every CI run into a false stale.
    expect(
      findStaleness({ reportMtimeMs: REPORT_AT, linted: [{ path: "a.ts", mtimeMs: REPORT_AT + 900 }] }),
    ).toBeNull()
    expect(
      findStaleness({ reportMtimeMs: REPORT_AT, linted: [{ path: "a.ts", mtimeMs: REPORT_AT + 1_500 }] }),
    ).not.toBeNull()
  })

  it("NO-CHANGE CONTROL: an empty linted list is not stale", () => {
    // "Nothing was linted" is the EMPTY-report failure, which has its own check
    // and its own exit code. Reporting it as staleness would misname it.
    expect(findStaleness({ reportMtimeMs: REPORT_AT, linted: [] })).toBeNull()
    expect(findStaleness({ reportMtimeMs: REPORT_AT, linted: undefined })).toBeNull()
  })
})

describe("the npm script regenerates the report it compares", () => {
  it("lint:ratchet runs eslint before the comparison", () => {
    // ⚠ The script alone measures nothing — it reads whatever JSON sits at the
    // path. This is the wiring, not a style preference: without the generate
    // step the local instrument and the CI job disagree, and the local one is
    // the optimistic liar.
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
    const cmd: string = pkg.scripts["lint:ratchet"]
    expect(cmd).toMatch(/eslint\b[^|]*--format json\s+-o/)
    expect(cmd).toContain("check-eslint-ratchet.mjs")
    // The generate step must come FIRST, or it is comparing the old report and
    // writing the new one for next time.
    expect(cmd.indexOf("eslint ")).toBeLessThan(cmd.indexOf("check-eslint-ratchet.mjs"))
  })

  it("CI generates the report in the same step as the comparison", () => {
    // A guard's blast radius is fixed by what RUNS it. If CI ever drops the
    // generate line, its ratchet job starts reading a stale runner-local file
    // too — and this test is where that shows up.
    const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8")
    const idx = ci.indexOf("check-eslint-ratchet.mjs")
    expect(idx).toBeGreaterThan(-1)
    const before = ci.slice(Math.max(0, idx - 400), idx)
    expect(before).toMatch(/eslint\s+\.[^\n]*--format json[^\n]*-o/)
  })
})
