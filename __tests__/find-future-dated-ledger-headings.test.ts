import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// `scripts/find-future-dated-ledger-headings.mjs` is the containment for the UTC
// stamping trap, it is wired into the `ledger-guard` CI job as a hard failure, and — like
// its sibling detector before it — it had no test.
//
// The failure: docs/overnight/ledger.md is dated PACIFIC, but every writer runs on a UTC
// clock (CI, the cloud sandbox, the nightly pass). Between 17:00 PT and midnight PT, UTC is
// already on the next day, so a `date -u` stamp writes a heading dated tomorrow. Measured
// 2026-08-17: FOUR entries (4b32934, a18c39a, b7ec40b, 2892f29, authored 17:46-18:21 PT)
// landed under `### 2026-08-18` headings inside 35 minutes, with the warning already
// present in BOTH the ledger header and CLAUDE.md, corrected by hand in `ae52ff3`.
//
// ⚠ THE INTERESTING PART IS WHAT THE SCRIPT REFUSES TO DO, AND THAT IS WHAT IS PINNED HERE.
// Its two design decisions are both cases where the OBVIOUS implementation passes its own
// happy path and is silently broken in the environment that matters:
//
//   1. It computes today in Pacific ITSELF. A guard that asks the host for "today" runs in
//      CI on a UTC clock and derives the same wrong date the bug did, so a tomorrow-stamped
//      entry looks like today's and the guard goes green — it reproduces the exact defect
//      it exists to catch. This suite therefore drives the detector at FIXED instants
//      through `TZ`, so the assertions do not quietly become "whatever today is".
//   2. It requires the strict `\d{4}-\d{2}-\d{2}` shape. A looser "heading that sorts above
//      today" test fires on 39 headings in the live ledger, because ANY first token
//      starting above `2` sorts above a date: 25 `### audit_2026…`, the `### <date>`
//      format example quoted in the ledger header, and 13 word headings (`### FINDING`,
//      `### Item`, `### Watch`, `### Atlas`…). A guard with 39 false positives gets
//      switched off. ⚠ Measured 2026-08-17 — the first version of this comment claimed
//      690, which was `grep -c 'audit_'`: LINES CONTAINING THE STRING ANYWHERE, not
//      headings. A substring line-count reported as an entity count, inflated ~27x, and
//      never measured before being written down.

const SCRIPT = path.resolve(__dirname, "../scripts/find-future-dated-ledger-headings.mjs")

/**
 * Run the detector over a temp file at a FIXED host timezone.
 * `tz` sets the host clock's zone — the point being that the answer must not depend on it.
 */
function detect(content: string, opts: { show?: boolean; tz?: string } = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "futuredate-"))
  const f = path.join(dir, "ledger.md")
  writeFileSync(f, content)
  const args = opts.show ? [SCRIPT, "--show", f] : [SCRIPT, f]
  return execFileSync(process.execPath, args, {
    encoding: "utf8",
    env: { ...process.env, TZ: opts.tz ?? "UTC" },
  }).trim()
}

const count = (content: string, tz?: string) => Number(detect(content, { tz }))

/** A heading dated far enough back that it can never be "today" while this test exists. */
const PAST = "### 2026-08-15 · SHIPPED (Claude Code) — something happened"
/** A heading dated far enough ahead that it is future-dated in every timezone, forever. */
const FUTURE = "### 2099-01-01 · SHIPPED (Claude Code) — stamped in a day that has not happened"

/** ISO date for `when` in a given zone, assembled from parts (never a locale format string). */
function isoIn(tz: string, when = new Date()): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(when)
      .map((x) => [x.type, x.value]),
  )
  return `${p.year}-${p.month}-${p.day}`
}

const PT_TODAY = isoIn("America/Los_Angeles")
const PT_TOMORROW = isoIn("America/Los_Angeles", new Date(Date.now() + 86_400_000))
// ⚠ NOT a constant date. `2099-01-01` is future in every zone, so it cannot distinguish a
// correct implementation from one that asks the host clock — it would pass either. Only a
// heading dated PACIFIC-TOMORROW can: under a host-clock implementation running east of PT,
// "tomorrow in PT" is already "today", so the guard would call it fine and this would red.
const PT_TOMORROW_HEADING = `### ${PT_TOMORROW} · SHIPPED — stamped a day early, the actual bug`
const PT_TODAY_HEADING = `### ${PT_TODAY} · SHIPPED — stamped correctly, in PT`

describe("find-future-dated-ledger-headings.mjs", () => {
  it("reports 0 on a ledger with no future-dated heading", () => {
    expect(count(`# Ledger\n\n${PAST}\n\nbody text\n\n### 2026-08-14 · older\n`)).toBe(0)
  })

  it("flags a heading dated in a day that has not happened", () => {
    expect(count(`# Ledger\n\n${FUTURE}\n\nbody\n\n${PAST}\n`)).toBe(1)
  })

  it("flags each future-dated heading separately", () => {
    expect(count(`${FUTURE}\n### 2099-02-02 · another\n${PAST}\n`)).toBe(2)
  })

  // ── The conversion, which is the entire reason this is Node and not awk ────
  // ⚠ These are the assertions that would go green on a broken implementation if the host
  // clock were allowed to decide. Driving TZ proves the answer is independent of it.
  it("draws the line at PACIFIC today: today's date passes, tomorrow's is flagged", () => {
    expect(count(`${PT_TODAY_HEADING}\n${PAST}\n`)).toBe(0)
    expect(count(`${PT_TOMORROW_HEADING}\n${PAST}\n`)).toBe(1)
  })

  it("gives that SAME answer whether the host clock is UTC, Pacific, Tokyo or UTC+14", () => {
    // Every zone here is at or ahead of PT, so a host-clock implementation would call
    // PACIFIC-TOMORROW "today" in at least one of them and return 0. That is what makes
    // this assertion load-bearing rather than a restatement of the case above.
    const md = `${PT_TOMORROW_HEADING}\n${PAST}\n`
    expect(count(md, "UTC")).toBe(1)
    expect(count(md, "America/Los_Angeles")).toBe(1)
    expect(count(md, "Asia/Tokyo")).toBe(1)
    expect(count(md, "Pacific/Kiritimati")).toBe(1) // UTC+14, the furthest ahead there is
  })

  it("--show names the offender and reports the host/PT skew that causes the bug", () => {
    const out = execFileSync(process.execPath, [SCRIPT, "--show", writeTemp(`${FUTURE}\n${PAST}\n`)], {
      encoding: "utf8",
      env: { ...process.env, TZ: "Asia/Tokyo" }, // a zone that is always ahead of PT
      stdio: ["ignore", "pipe", "pipe"],
    })
    expect(out).toMatch(/^1: ### 2099-01-01/m)
  })

  // ── The strict date shape, i.e. the 39 false positives it declines to raise ──
  it("does NOT flag the 25 `### audit_…` headings, which sort above any date as strings", () => {
    // `a` > `2`, so a loose comparison calls every one of these future-dated.
    const md = "### audit_20260705_secdef_anon_exec · a real heading in this file\n" + `${PAST}\n`
    expect("audit_20260705" > "2026-08-17").toBe(true) // the trap being avoided
    expect(count(md)).toBe(0)
  })

  it("does NOT flag the `### <date>` format example quoted in the ledger header", () => {
    expect(count("### <date> · status · what · revert path\n" + `${PAST}\n`)).toBe(0)
  })

  it("reads line-start headings only, so a quoted date in prose is not a heading", () => {
    expect(count("Stamp a dated `### 2099-01-01` heading only after converting to PT.\n")).toBe(0)
  })

  it("ignores `##` and `####` headings", () => {
    expect(count("## 2099-01-01 not an entry\n#### 2099-01-01 nor this\n")).toBe(0)
  })

  // ── Output contract, the same misread its sibling documented ──────────────
  // ⚠ The default mode prints ONE line containing a number. `| wc -l` therefore reads 1
  // whatever the count is — the misread that produced a session's worth of wrong
  // "swallowed=1" readings against the sibling detector. CI compares the NUMBER.
  it("default mode emits exactly ONE line, so `| wc -l` can never report the count", () => {
    expect(detect(`${PAST}\n`).split("\n")).toHaveLength(1)
    expect(detect(`${FUTURE}\n### 2099-02-02 · b\n### 2099-03-03 · c\n`).split("\n")).toHaveLength(1)
    expect(detect(`${PAST}\n`)).toBe("0")
    expect(detect(`${FUTURE}\n### 2099-02-02 · b\n### 2099-03-03 · c\n`)).toBe("3")
  })

  it("prints 0 rather than an empty string, so CI's numeric compare works", () => {
    // ci.yml does `[ "$FD" -gt 0 ]`, which errors rather than passes on an empty string.
    expect(detect("no headings here at all\n")).toBe("0")
  })

  it("--show prints nothing on stdout for a clean file", () => {
    expect(detect(`${PAST}\n`, { show: true })).toBe("")
  })
})

describe("the live ledger is clean", () => {
  const LEDGER_MD = path.resolve(__dirname, "../docs/overnight/ledger.md")

  // ⚠ THE STRICT-SHAPE ARGUMENT, MADE EXECUTABLE RATHER THAN ASSERTED IN A COMMENT.
  // The prose above cites 39 loose hits vs 0 strict ones, measured 2026-08-17. A number in
  // a comment is exactly what got this file wrong the first time — 690 was a substring
  // LINE count copied in without being measured. This derives both numbers from the live
  // file at run time, so the claim cannot rot and cannot be a claim-without-measurement.
  // Bounds, not equalities: audit headings keep being added, and pinning 39 would make an
  // ordinary ledger append red for no reason.
  it("a loose 'sorts above today' rule would flag many live headings; the strict one flags none", () => {
    const md = readFileSync(LEDGER_MD, "utf8")
    const today = isoIn("America/Los_Angeles")
    const loose = md.split("\n").filter((l) => {
      const m = /^### (\S+)/.exec(l)
      return m ? m[1] > today : false
    })
    const strict = md.split("\n").filter((l) => {
      const m = /^### (\d{4}-\d{2}-\d{2})\b/.exec(l)
      return m ? m[1] > today : false
    })
    expect(strict).toHaveLength(0)
    expect(loose.length).toBeGreaterThan(10) // 39 when measured 2026-08-17
  })

  it("has no future-dated heading right now", () => {
    const out = execFileSync(
      process.execPath,
      [SCRIPT, path.resolve(__dirname, "../docs/overnight/ledger.md")],
      { encoding: "utf8" },
    ).trim()
    expect(out).toBe("0")
  })
})

function writeTemp(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "futuredate-"))
  const f = path.join(dir, "ledger.md")
  writeFileSync(f, content)
  return f
}
