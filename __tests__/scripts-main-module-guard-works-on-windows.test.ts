import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

// BAN AT ZERO: no script may detect "am I the main module?" by string-comparing
// `import.meta.url` against a raw `file://` + process.argv[1].
//
// ── WHY THIS EXISTS (2026-08-28) ──────────────────────────────────────────────
// `import.meta.url` is ALWAYS a URL. `process.argv[1]` is an OS path. On Linux the
// two happen to line up, because a POSIX path starts with "/" and `file://` + "/x"
// is a valid file URL. On Windows argv[1] is `C:\Users\...\x.mjs`, so the compare
// is `file:///C:/Users/.../x.mjs` === `file://C:\Users\...\x.mjs` — never true.
//
// The failure is SILENT AND IT IS THE WORST KIND: main() simply never runs, the
// process exits 0, and nothing is printed. `scripts/gen-known-issues-index.mjs`
// carried this for its whole life. Measured on the maintainer's own Windows box:
// BOTH `npm run docs:issues-index` (the WRITER) and `-- --check` (the GUARD)
// exited 0 having done nothing — so regenerating the index was a no-op and the
// guard passed vacuously, while CI stayed green on Linux the entire time. That is
// CLAUDE.md's "a permanently-zero instrument is indistinguishable from a broken
// one", and the platform this repo is developed on is the one where it breaks.
//
// scripts/ingest-topshot-active-listings.mjs already documented the correct idiom
// and the reason; nothing connected that knowledge to the other scripts. This does.
//
// ⚠ The banned needle is ASSEMBLED rather than written as a literal, so this file
// cannot match itself — the "a guard satisfied by its own source" trap.
const BANNED = "file://" + "${process.argv[1]}"

const SCRIPTS = path.join(process.cwd(), "scripts")

function mjsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...mjsFiles(full))
    else if (entry.endsWith(".mjs") || entry.endsWith(".js")) out.push(full)
  }
  return out
}

describe("scripts must not use the Windows-broken main-module check", () => {
  const files = mjsFiles(SCRIPTS)

  it("inspected a non-empty set of scripts (the guard cannot pass vacuously)", () => {
    // Asserting the COUNT it inspected, not just the verdict: a walk that finds
    // nothing looks exactly like a clean repo.
    expect(files.length).toBeGreaterThan(50)
  })

  it("no script compares import.meta.url to a raw file:// + argv[1]", () => {
    const offenders = files
      .filter((f) => readFileSync(f, "utf8").includes(BANNED))
      .map((f) => path.relative(process.cwd(), f))
    expect(offenders).toEqual([])
  })

  it("the ban's needle actually matches the shape it bans (proven on a known offender)", () => {
    // The pre-fix line from gen-known-issues-index.mjs, verbatim. Without this a
    // typo'd needle would make the ban silently unfalsifiable — the mechanism
    // CLAUDE.md records as "prove a scripted guard against a KNOWN OFFENDER".
    const knownOffender = "if (import.meta.url === `" + BANNED + "`) main()"
    expect(knownOffender.includes(BANNED)).toBe(true)
    // ...and the correct idiom must NOT trip it.
    const fixed =
      "process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href"
    expect(fixed.includes(BANNED)).toBe(false)
  })
})

describe("gen-known-issues-index actually runs when invoked directly", () => {
  // Reading the condition is not enough — that is how it stayed broken. This
  // asserts the OBSERVABLE consequence: the script prints its summary, including
  // the count of items it inspected.
  it("prints its summary line with a non-zero item count", async () => {
    const { execFileSync } = await import("node:child_process")
    const out = execFileSync(
      process.execPath,
      [path.join(SCRIPTS, "gen-known-issues-index.mjs"), "--check"],
      { encoding: "utf8", cwd: process.cwd() },
    )
    expect(out).toMatch(/known-issues index is current — \d+ items inspected/)
    const n = Number(/— (\d+) items inspected/.exec(out)?.[1] ?? 0)
    expect(n).toBeGreaterThan(0)
  })
})
