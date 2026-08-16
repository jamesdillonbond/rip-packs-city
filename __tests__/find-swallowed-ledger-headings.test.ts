import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// `scripts/find-swallowed-ledger-headings.awk` is the ONLY containment for a failure that
// has destroyed ledger content five times, and it had no test.
//
// The failure: docs/overnight/ledger.md is append-at-top and written concurrently. A write
// that splices on the SUBSTRING "### " rather than a line-start "^### " lands mid-sentence.
// The new entry's heading ends up buried inside another line (so it has no heading of its
// own) and the host sentence's tail becomes a bogus heading. Nothing is deleted and the
// heading COUNT GOES UP, so the ledger-guard's count AND set checks both pass on a damaged
// file. This script is what closes that.
//
// ⚠ ITS RULE IS SUBTLER THAN IT LOOKS, AND THE OBVIOUS SPELLING IS WRONG. "flag a mid-line
// `### <date>` not preceded by a backtick" MISSES the very incident that motivated the
// script (697dd86b), because that splice landed immediately AFTER a quoting backtick. What
// distinguishes a deliberate prose CITATION from a swallowed heading is a CLOSED code span:
// a backtick before AND a closing backtick after, on the same line. Both halves are
// asserted below, including the near-miss the wrong rule would let through.
//
// ⚠ AND ITS OUTPUT HAS A DOCUMENTED MISREAD WORTH PINNING: the default mode PRINTS A COUNT,
// one line. A whole session's worth of "swallowed=1" readings came from piping it to
// `wc -l`, which reads 1 no matter what the count is. That is asserted here so the trap is
// executable rather than only described in prose.

const AWK = path.resolve(__dirname, "../scripts/find-swallowed-ledger-headings.awk")

function awkAvailable(): boolean {
  try {
    execFileSync("awk", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    try {
      // busybox/mawk answer --version with a non-zero status but do run.
      execFileSync("awk", ["BEGIN{exit 0}"], { stdio: "ignore" })
      return true
    } catch {
      return false
    }
  }
}

const HAVE_AWK = awkAvailable()

/** Run the detector over a temp file. Returns trimmed stdout. */
function detect(content: string, show = false): string {
  const dir = mkdtempSync(path.join(tmpdir(), "swallow-"))
  const f = path.join(dir, "ledger.md")
  writeFileSync(f, content)
  const args = show ? ["-v", "show=1", "-f", AWK, f] : ["-f", AWK, f]
  return execFileSync("awk", args, { encoding: "utf8" }).trim()
}

const count = (content: string) => Number(detect(content))

// A real heading, formatted exactly as the ledger writes them.
const HEADING = "### 2026-08-16 · SHIPPED (Claude Code) — something happened"

describe.skipIf(!HAVE_AWK)("find-swallowed-ledger-headings.awk", () => {
  it("reports 0 on a clean ledger", () => {
    expect(count(`# Ledger\n\n${HEADING}\n\nbody text\n\n### 2026-08-15 · SHIPPED — older\n`)).toBe(0)
  })

  it("reports 0 for a heading at the very start of the file (no preceding newline)", () => {
    expect(count(`${HEADING}\n\nbody\n`)).toBe(0)
  })

  // ── The failure it exists for ─────────────────────────────────────────────
  it("flags a heading swallowed into the middle of a sentence", () => {
    const damaged = "# Ledger\n\nThe format is one entry per ### 2026-08-16 · SHIPPED — spliced mid-line\n"
    expect(count(damaged)).toBe(1)
  })

  it("flags each swallowed heading separately", () => {
    const damaged =
      "some prose ### 2026-08-16 · one\nmore prose ### 2026-08-15 · two\n" + `${HEADING}\n`
    expect(count(damaged)).toBe(2)
  })

  // ── The rule that makes it correct: a CLOSED code span is a citation ──────
  it("does NOT flag a heading quoted inside a closed code span", () => {
    const cited = "Format per item: `### <date> · status · what`, newest first.\n"
    // Same shape with a real date, which is what the ledger header actually contains.
    const citedReal = "Stamp a dated `### 2026-08-16` heading only after converting to PT.\n"
    expect(count(cited)).toBe(0)
    expect(count(citedReal)).toBe(0)
  })

  // ⚠ THE NEAR-MISS. The obvious rule — "not preceded by a backtick" — would call this
  // clean, and it is exactly the shape of incident 697dd86b: the splice landed immediately
  // after a quoting backtick, so the character before it IS a backtick, but the span is
  // never closed. The detector must still flag it.
  it("DOES flag a splice that lands right after a backtick with no closing backtick", () => {
    const damaged = "Stamp a dated `### 2026-08-16 · SHIPPED — spliced after the opening backtick\n"
    expect(count(damaged)).toBe(1)
  })

  it("does not flag prose containing ### without a date", () => {
    expect(count("see the ### section below for the format\n")).toBe(0)
  })

  it("does not flag a non-heading-shaped date", () => {
    expect(count("shipped on 2026-08-16 in the usual way\n")).toBe(0)
  })

  // ── Output contract ──────────────────────────────────────────────────────
  it("show=1 prints one line per offender with its line number and text", () => {
    const damaged = "clean line\nprose ### 2026-08-16 · SHIPPED — spliced\n"
    const out = detect(damaged, true)
    expect(out.split("\n")).toHaveLength(1)
    expect(out).toMatch(/^2: prose ### 2026-08-16/)
  })

  it("show=1 prints NOTHING for a clean file (so an empty output means clean)", () => {
    expect(detect(`${HEADING}\n\nbody\n`, true)).toBe("")
  })

  // ⚠ THE DOCUMENTED MISREAD, MADE EXECUTABLE. The default mode emits ONE line containing a
  // number. Piping it to `wc -l` therefore reads 1 whether the true count is 0, 3 or 300 —
  // which is how a session logged "swallowed=1" repeatedly while the real value was 3.
  // Compare the NUMBER, or diff the whole output; never count its lines.
  it("default mode emits exactly ONE line, so `| wc -l` can never report the count", () => {
    const clean = detect(`${HEADING}\n`)
    const damaged = detect("a ### 2026-08-16 · x\nb ### 2026-08-15 · y\nc ### 2026-08-14 · z\n")
    expect(clean.split("\n")).toHaveLength(1)
    expect(damaged.split("\n")).toHaveLength(1)
    expect(clean).toBe("0")
    expect(damaged).toBe("3")
  })

  it("prints 0 rather than an empty string for a clean file, so a numeric compare works", () => {
    // The CI check does `[ "$SW_AFTER" -gt "$SW_BEFORE" ]`, which needs a number on both
    // sides; an empty string would make the comparison an error rather than a pass.
    expect(detect("no headings here at all\n")).toBe("0")
  })

  // ── The delta the CI check actually performs ─────────────────────────────
  it("supports the DELTA the ledger-guard uses: pre-existing damage must not red a clean push", () => {
    // Three un-repaired 2026-08-11 splices are live in the real ledger. The CI check
    // compares before -> after rather than asserting 0, precisely so they do not fail every
    // unrelated push while a NEW one still does.
    const before = "prose ### 2026-08-11 · old damage\n"
    const unchanged = `${before}${HEADING}\n`
    const worse = `${before}another ### 2026-08-16 · new damage\n`
    expect(count(unchanged)).toBe(count(before)) // adding a proper heading: no delta
    expect(count(worse)).toBeGreaterThan(count(before)) // a new splice: caught
  })
})

describe("the detector test is not silently skipped in CI", () => {
  it("awk is available wherever CI runs this suite", () => {
    // A skipped guard is not a guard. On a dev box without awk the cases above skip with a
    // visible marker; in CI (ubuntu-latest, awk always present) absence is a hard failure,
    // so the containment can never quietly stop being exercised.
    if (process.env.CI) expect(HAVE_AWK).toBe(true)
    else expect(typeof HAVE_AWK).toBe("boolean")
  })
})
