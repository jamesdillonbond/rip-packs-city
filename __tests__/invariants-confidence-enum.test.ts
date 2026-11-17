import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "fs"
import path from "path"
import { computeConfidence, type FmvConfidence } from "@/lib/fmv-confidence"

// ARCHITECTURE GUARD — fmv_snapshots.confidence enum handling.
//
// Per CLAUDE.md: `fmv_snapshots.confidence` is a Postgres enum whose values are
// UPPERCASE (HIGH/MEDIUM/LOW/…). Two documented, repeat bugs:
//   1. `.eq("confidence","high")` (lowercase) never matches — always uppercase.
//   2. `.ilike` on an enum column ERRORS (fix f55e022 + e9c90e5) — enums don't
//      support ILIKE; you must use `.eq`.
//
// This guard (1) pins the module's canonical values as uppercase and (2) scans
// lib/ + app/ for any `.ilike("confidence", …)` — which would reintroduce the
// enum-ILIKE error class — and fails if one appears.

const REPO = process.cwd()
const SCAN_DIRS = [path.join(REPO, "lib"), path.join(REPO, "app")]

function walkTs(dir: string): string[] {
  const out: string[] = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue
      out.push(...walkTs(full))
    } else if ((e.name.endsWith(".ts") || e.name.endsWith(".tsx")) && !e.name.endsWith(".d.ts")) {
      out.push(full)
    }
  }
  return out
}

// Matches `.ilike("confidence", ...)` / `.ilike('confidence', ...)` and the
// fmv_confidence column variant, tolerant of whitespace.
const ILIKE_CONFIDENCE_RE = /\.ilike\(\s*["'](?:fmv_)?confidence["']/

describe("invariant: fmv confidence enum is UPPERCASE and never ILIKE'd", () => {
  it("computeConfidence only ever returns uppercase enum values", () => {
    const allowed = new Set<FmvConfidence>(["HIGH", "MEDIUM", "LOW"])
    for (const n of [0, 1, 4, 5, 6, 7, 20, 100]) {
      const c = computeConfidence(n)
      expect(allowed.has(c), `computeConfidence(${n}) => ${c}`).toBe(true)
      expect(c).toBe(c.toUpperCase())
    }
  })

  it("no source file calls .ilike on the confidence enum column", () => {
    const offenders: string[] = []
    for (const dir of SCAN_DIRS) {
      for (const file of walkTs(dir)) {
        // skip this guard file and other test files
        if (file.includes("__tests__")) continue
        const src = readFileSync(file, "utf8")
        if (ILIKE_CONFIDENCE_RE.test(src)) offenders.push(path.relative(REPO, file))
      }
    }
    expect(
      offenders,
      `.ilike on the confidence enum ERRORS in Postgres — use .eq (see f55e022):\n` +
        offenders.map((o) => `  ${o}`).join("\n"),
    ).toEqual([])
  })

  it("actually scanned a meaningful number of source files (guard is live)", () => {
    const count = SCAN_DIRS.reduce((n, d) => n + walkTs(d).length, 0)
    expect(count).toBeGreaterThan(200)
    // sanity: the scan roots exist
    for (const d of SCAN_DIRS) expect(statSync(d).isDirectory()).toBe(true)
  })
})
