import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import {
  REGISTER_PATH,
  splitCells,
  parseRows,
  checkRegister,
  registerExitCode,
} from "../scripts/check-register-integrity.mjs"

// `docs/audits/deep-audit-register.md` is the canonical open list, and until
// 2026-08-29 it was the only one of the three coordination files with no guard
// at all (the ledger has the no-clobber + future-date arms; `inbox/INDEX.md` has
// four CI assertions, two of them counts).
//
// These tests exist to keep the guard's two failure directions honest:
//   - it must REPORT a raw `|`, a vanished row and a duplicate id;
//   - it must NOT report an escaped `\|`, a RESOLVED row's narrower schema, or a
//     row that legitimately MOVED from OPEN to RESOLVED.
// The false-positive controls matter as much as the positives here: the first
// draft of this guard hardcoded `{OPEN: 6, RESOLVED: 5}`, and a wrong number in
// a guard reads exactly like a defect in the data.

const OPEN_HEADER = `## OPEN

| id | first seen | sev | finding | current evidence | owner |
|---|---|---|---|---|---|
`
const RESOLVED_HEADER = `## RESOLVED

| id | resolved | finding | fix | revert path |
|---|---|---|---|---|
`
const openRow = (id: string, evidence = "measured") =>
  `| ${id} | 2026-08-29 | P2 | a finding | ${evidence} | Claude Code |\n`
const resolvedRow = (id: string) => `| ${id} | 2026-08-29 | a finding | the fix | git revert abc123 |\n`

const REGISTER =
  OPEN_HEADER + openRow("R90") + openRow("R91") + "\n" + RESOLVED_HEADER + resolvedRow("R80") + resolvedRow("R81")

describe("splitCells", () => {
  it("does NOT open a column on an ESCAPED pipe — `\\|` is legal markdown inside a cell", () => {
    // R6 and R32 both use it; the first parser reported them at 8 and 10 columns.
    expect(splitCells("| a | b \\| c | d |")).toEqual(["a", "b \\| c", "d"])
  })

  it("DOES open a column on a raw pipe inside BACKTICKS — markdown splits before it parses code", () => {
    // This asymmetry is the entire point. `` `/(ts|tsx)/` `` really does break its row.
    expect(splitCells("| a | `/(ts|tsx)/` | d |")).toHaveLength(4)
  })
})

describe("the register integrity guard", () => {
  it("passes a well-formed register and says how many rows it inspected", () => {
    const r = checkRegister({ after: REGISTER })
    expect(r.inspected).toBe(4)
    expect(r.ok).toBe(true)
    expect(registerExitCode(r)).toBe(0)
  })

  it("does NOT flag a RESOLVED row for having fewer columns than an OPEN one", () => {
    // The schema is read from each section's OWN header, so the two widths coexist.
    expect(checkRegister({ after: REGISTER }).malformed).toEqual([])
    const widths = parseRows(REGISTER).rows.map((row) => row.expected)
    expect(widths).toEqual([6, 6, 5, 5])
  })

  it("does NOT flag a cell containing an escaped pipe", () => {
    const after = OPEN_HEADER + openRow("R90", "matched `/\\.(ts\\|tsx)$/`") + openRow("R91") + "\n" + RESOLVED_HEADER + resolvedRow("R80") + resolvedRow("R81")
    expect(checkRegister({ after }).malformed).toEqual([])
  })

  it("REPORTS a row broken by a raw pipe, naming the width its own section declares", () => {
    const after = OPEN_HEADER + openRow("R90", "matched `/\\.(ts|tsx)$/`") + openRow("R91") + "\n" + RESOLVED_HEADER + resolvedRow("R80") + resolvedRow("R81")
    const r = checkRegister({ after })
    expect(r.malformed).toEqual([{ id: "R90", columns: 7, section: "OPEN", expected: 6 }])
    expect(registerExitCode(r)).toBe(1)
  })

  it("REPORTS a row carrying an EXTRA structural cell, whose last column the renderer drops", () => {
    // R46's real shape, and a different cause from the backtick case: the row was
    // written with a 7th cell in a 6-column table. GFM keeps the first 6 and
    // DISCARDS the rest, so `owner` vanished from the rendered table while the
    // decision text moved into its column. Nothing greps as missing.
    const after =
      OPEN_HEADER +
      "| R90 | 2026-08-29 | P2 | a finding | the evidence | the decision | Claude Code |\n" +
      openRow("R91") +
      "\n" +
      RESOLVED_HEADER +
      resolvedRow("R80") +
      resolvedRow("R81")
    const r = checkRegister({ after })
    expect(r.malformed).toEqual([{ id: "R90", columns: 7, section: "OPEN", expected: 6 }])
    expect(registerExitCode(r)).toBe(1)
  })

  it("REPORTS a row that vanished between the parent revision and this one", () => {
    const after = OPEN_HEADER + openRow("R90") + "\n" + RESOLVED_HEADER + resolvedRow("R80") + resolvedRow("R81")
    const r = checkRegister({ after, before: REGISTER })
    expect(r.vanished).toEqual(["R91"])
    expect(registerExitCode(r)).toBe(1)
  })

  it("REPORTS a row deleted from the RESOLVED section, not just from OPEN", () => {
    // ⚠ A mutation restricting the parent set to OPEN survived every other test
    // here: deleting resolved history is invisible unless it is asserted directly.
    // RESOLVED is where the revert paths live, so losing a row there is the more
    // expensive half of the clobber.
    const after = OPEN_HEADER + openRow("R90") + openRow("R91") + "\n" + RESOLVED_HEADER + resolvedRow("R80")
    const r = checkRegister({ after, before: REGISTER })
    expect(r.vanished).toEqual(["R81"])
    expect(registerExitCode(r)).toBe(1)
  })

  it("does NOT report a row that MOVED from OPEN to RESOLVED — that is the lifecycle, not a loss", () => {
    // The false positive that would make the guard punish the one edit it exists to protect.
    const after = OPEN_HEADER + openRow("R90") + "\n" + RESOLVED_HEADER + resolvedRow("R91") + resolvedRow("R80") + resolvedRow("R81")
    const r = checkRegister({ after, before: REGISTER })
    expect(r.vanished).toEqual([])
    expect(r.ok).toBe(true)
  })

  it("REPORTS a duplicated id, which makes every reference to it ambiguous", () => {
    const after = OPEN_HEADER + openRow("R90") + openRow("R90") + "\n" + RESOLVED_HEADER + resolvedRow("R80") + resolvedRow("R81")
    const r = checkRegister({ after })
    expect(r.duplicated).toEqual(["R90"])
    expect(registerExitCode(r)).toBe(1)
  })

  it("FAILS on an empty register rather than passing — a guard that inspects nothing looks like one that found nothing", () => {
    const r = checkRegister({ after: "# RPC deep-audit findings register\n" })
    expect(r.inspected).toBe(0)
    expect(registerExitCode(r)).toBe(2)
  })

  it("FAILS when only ONE section contributes, even though the row count looks healthy", () => {
    // A parser that quietly stopped matching RESOLVED would still report 2 rows.
    const after = OPEN_HEADER + openRow("R90") + openRow("R91")
    const r = checkRegister({ after })
    expect(r.inspected).toBe(2)
    expect(r.contributing).toEqual(["OPEN"])
    // ⚠ Asserted on BOTH `ok` and the exit code. They are computed separately, so
    // testing only the exit code let a mutation that dropped the floor from `ok`
    // survive: two agreeing signals, one of them silently wrong.
    expect(r.ok).toBe(false)
    expect(registerExitCode(r)).toBe(2)
  })

  it("skips a non-id-keyed section, and records the PROPERTY that excused it", () => {
    const after =
      REGISTER +
      "\n## VERIFIED-CLEAN\n\n| area | last verified | probe | expected |\n|---|---|---|---|\n| ownership sync | 2026-08-27 | a probe | a result |\n"
    const r = checkRegister({ after })
    expect(r.inspected).toBe(4) // the VERIFIED-CLEAN row is not counted
    expect(r.skipped).toEqual([{ name: "VERIFIED-CLEAN", firstColumn: "area" }])
  })

  it("picks up a NEW id-keyed section with no edit to the guard", () => {
    // The exclusion is a property, not a named list, so this must just work.
    const after = REGISTER + "\n## DEFERRED\n\n| id | filed | finding | owner |\n|---|---|---|---|\n| R99 | 2026-08-29 | a finding | Trevor |\n"
    const r = checkRegister({ after })
    expect(r.contributing).toEqual(["OPEN", "RESOLVED", "DEFERRED"])
    expect(parseRows(after).rows.find((row) => row.id === "R99")?.expected).toBe(4)
  })
})

describe("the register integrity guard, against the real file", () => {
  const src = readFileSync(REGISTER_PATH, "utf8")

  it("is green on the register as committed", () => {
    const r = checkRegister({ after: src })
    expect(r.malformed).toEqual([])
    expect(r.duplicated).toEqual([])
    expect(registerExitCode(r)).toBe(0)
  })

  it("inspects BOTH id-keyed sections in bulk — neither may silently stop matching", () => {
    // The count is deliberately a floor, not a pin: the register grows. What is
    // pinned is that both roots CONTRIBUTE, which a shape regression would break
    // while the total still looked plausible.
    const { sections } = parseRows(src)
    const byName = Object.fromEntries(sections.filter((s) => s.idKeyed).map((s) => [s.name, s.rows]))
    expect(byName["OPEN"]).toBeGreaterThan(20)
    expect(byName["RESOLVED"]).toBeGreaterThan(20)
  })

  it("really does exclude the two prose sections by their first column, not by name", () => {
    const skipped = checkRegister({ after: src }).skipped
    expect(skipped.map((s) => s.firstColumn).sort()).toEqual(["area", "item"])
  })
})
