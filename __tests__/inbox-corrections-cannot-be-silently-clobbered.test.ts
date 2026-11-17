import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// A correction block must not be able to disappear from an inbox filing.
//
// ── THE INCIDENT (2026-09-03) ───────────────────────────────────────────────
// Two sessions edited one filing twenty minutes apart. The second rewrote it in
// place from a copy read before the first landed, deleting an 84-line
// `## ⛔ CORRECTION` block — the block refuting the filing's headline number. A
// human reading the diff caught it.
//
// 🚨 ALL THREE EXISTING INBOX GUARDS PASSED AND NONE COULD HAVE FAILED. They ask
// which filings exist and how many; a rewrite that keeps the file keeps the
// count. That is the ledger's 2026-07 lesson ("diff the SET, not the count",
// 2966c0a, 356 → 356 while destroying two revert paths) sitting unlearned one
// directory over.
//
// ── ⭐ THE DETECTOR TOOK THREE DESIGNS, AND THE TWO FAILURES ARE THE POINT ───
// v1, "every `## ` heading before must exist after": caught the incident, then
// FALSE-POSITIVED on the repair, because the repairing session renamed two
// sections while merging. A guard that reds main for an ordinary edit is one
// people disable.
//
// v2, "the after-file must still contain SOME correction heading": MISSED the
// incident, because the clobbering commit added its own correction while
// deleting the other — 1 → 1. ⛔ **The count-blindness lesson, reproduced inside
// the guard written to catch count-blindness.**
//
// v3 keys on CONTENT: a correction's longest body lines must still appear
// somewhere. Robust to renaming and moving; fails when the text is gone.
//
// ⚠ These cases are built from the REAL before/after text of the incident, not
// from invented markdown, so they fail if the detector stops catching the thing
// that actually happened.
// ─────────────────────────────────────────────────────────────────────────────

const SCRIPT = "scripts/find-clobbered-inbox-corrections.mjs"

function run(before: string, after: string, show = false): string {
  const dir = mkdtempSync(join(tmpdir(), "inbox-clobber-"))
  const b = join(dir, "before.md")
  const a = join(dir, "after.md")
  writeFileSync(b, before)
  writeFileSync(a, after)
  const args = show ? ["--show", b, a] : [b, a]
  return execFileSync("node", [SCRIPT, ...args], { encoding: "utf8" }).trim()
}

/** Shaped like the real filing: a correction block with substantive prose. */
const WITH_CORRECTION = [
  "# Sixteen routes filter fmv_current by an id list",
  "",
  "## ⛔ CORRECTION, 2026-09-03 — DO NOT ACT ON THE TABLE BELOW. IT IS REFUTED.",
  "",
  "Re-measured, same view, same session, both the literal-IN form and the bound",
  "= ANY($1) form PostgREST actually emits. The cost is PROPORTIONAL, about fifty",
  "to seventy buffers per edition; it is not fixed, and a three-id call costs 23.",
  "",
  "## The measurement",
  "",
  "Three shapes, same view, same session, with the numbers that started all this.",
  "",
].join("\n")

describe("an inbox correction cannot be silently clobbered", () => {
  it("catches a correction deleted by a rewrite-in-place — THE INCIDENT", () => {
    // The clobbering commit also ADDED its own correction heading, which is why
    // a count check saw 1 → 1 and passed.
    const clobbered = [
      "# Sixteen routes filter fmv_current by an id list",
      "",
      "## The discriminator — ⛔ CORRECTED 23:50Z, my first version was too generous",
      "",
      "Something else entirely, written from a copy read before the other landed.",
      "",
      "## The measurement",
      "",
      "Three shapes, same view, same session, with the numbers that started all this.",
      "",
    ].join("\n")
    expect(run(WITH_CORRECTION, clobbered)).toBe("1")
    expect(run(WITH_CORRECTION, clobbered, true)).toContain("IT IS REFUTED")
  })

  it("NO-CHANGE CONTROL: a RENAMED correction that kept its text is not reported", () => {
    // v1 died here. The repairing session renamed sections while merging, which
    // is an ordinary edit on free-form prose.
    const renamed = WITH_CORRECTION.replace(
      "## ⛔ CORRECTION, 2026-09-03 — DO NOT ACT ON THE TABLE BELOW. IT IS REFUTED.",
      "## ⛔ CORRECTED TWICE — the first version was wrong in the direction that does harm",
    )
    expect(run(WITH_CORRECTION, renamed)).toBe("0")
  })

  it("NO-CHANGE CONTROL: a correction MOVED to the end of the file is not reported", () => {
    const lines = WITH_CORRECTION.split("\n")
    const moved = [...lines.slice(8), ...lines.slice(0, 8)].join("\n")
    expect(run(WITH_CORRECTION, moved)).toBe("0")
  })

  it("NO-CHANGE CONTROL: an unchanged file, and a filing that never had one", () => {
    expect(run(WITH_CORRECTION, WITH_CORRECTION)).toBe("0")
    const plain = "# A filing\n\n## The measurement\n\nSome prose that is long enough to be a fingerprint line.\n"
    expect(run(plain, plain)).toBe("0")
    expect(run(plain, "# A filing\n\n## Something else\n\nDifferent prose entirely, also long enough to count here.\n")).toBe("0")
  })

  it("prints a COUNT, not a list — so a clean run is '0' and not an empty string", () => {
    // The repo has lost this distinction before: `| wc -l` on a clean run of a
    // count-printing detector returns 1, which reads as one offender.
    expect(run(WITH_CORRECTION, WITH_CORRECTION)).toBe("0")
    expect(run(WITH_CORRECTION, WITH_CORRECTION)).not.toBe("")
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// A detector nothing RUNS is not a guard.
//
// ⚠ This repo's recorded lesson is "ask what RUNS a guard, not only whether it
// passes" — a staged-only default once inspected NOTHING on a CI checkout and
// exited 0. The comparison arm cannot live in vitest (it needs HEAD~1), so it
// lives in a workflow job, and the only thing that can notice the job being
// deleted or renamed is a test that reads the workflow.
// ─────────────────────────────────────────────────────────────────────────────
describe("the inbox clobber detector is wired to CI", () => {
  const ci = readFileSync(join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8")

  it("read a real workflow — a broken read must not pass as compliance", () => {
    // POSITIVE CONTROL: if this file ever stops containing the jobs it plainly
    // has, the read is wrong and every assertion below is vacuous.
    expect(ci).toContain("ledger-guard:")
    expect(ci.length).toBeGreaterThan(10_000)
  })

  it("a job invokes the detector", () => {
    expect(ci).toContain("inbox-guard:")
    expect(ci).toContain(SCRIPT)
  })

  it("the job can actually see the previous revision", () => {
    // The comparison is against HEAD~1. actions/checkout defaults to depth 1, so
    // without this the step would hit "no parent commit — skip" on every push and
    // pass forever — the exact silent no-op shape the step's own error text
    // refuses to accept from the detector.
    const job = ci.slice(ci.indexOf("inbox-guard:"))
    const body = job.slice(0, job.indexOf("\n  # ") === -1 ? job.length : job.indexOf("\n  # "))
    expect(body).toContain("fetch-depth: 2")
  })
})
