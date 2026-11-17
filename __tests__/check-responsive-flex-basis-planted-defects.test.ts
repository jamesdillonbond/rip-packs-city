import { describe, it, expect, afterAll } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// `scripts/check-responsive-flex-basis.mjs` IS A CI GATE (ci.yml, typecheck job)
// WHOSE ONLY PROOF OF REDDENING WAS ONE MANUAL PROBE.
//
// It shipped 2026-08-22 with a header recording that its FIRST cut printed
// "clean" while ~90% of the tree was outside it (a regex closed each @media at
// the first nested brace). The estate probe in docs/reference/testing-and-ci.md
// reddened it once by hand and filed it among the guards that "can silently
// rot": no test re-ran it, so a regression to the same shape would have kept CI
// green the same way. Measured 2026-10-02: of the scripts a workflow runs, this
// was the only GATE no test touches (the other five are runners/fetchers).
// ⭐ Mutation-checked 2026-10-02: re-planting the first-cut brace bug in
// mediaBlocks() reds 6 of these 7 cases.
//
// ⚠ Its header also CONTRADICTED ITSELF about the Tailwind arm: one paragraph
// said `flex-col sm:flex-row` IS covered, a bullet below said it is "NOT
// parsed". The code covers it. Case (2) settles that by running it, and the
// stale bullet is gone from the header.
//
// Each case is a fixture tree the script runs against with cwd set to it (its
// ROOTS are cwd-relative). The script, and the strip-comments helper it
// imports, stay the real ones.
// ─────────────────────────────────────────────────────────────────────────────

const SCRIPT = path.resolve(__dirname, "..", "scripts", "check-responsive-flex-basis.mjs")
const made: string[] = []

/** A container class that flips to a column at a breakpoint, in a global sheet. */
const GLOBAL_CSS = "@media (max-width: 640px) {\n  .rpc-band { flex-direction: column; }\n}\n"

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rfb-"))
  made.push(dir)
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), body)
  }
  return dir
}

function run(cwd: string) {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd, encoding: "utf8" })
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` }
}

afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

describe("check-responsive-flex-basis — planted defects", () => {
  it("(1) reds on an inline length basis inside a class a GLOBAL sheet flips to column", () => {
    const dir = fixture({
      "app/tokens.css": GLOBAL_CSS,
      "components/Band.tsx":
        'export const Band = () => <div className="rpc-band"><input style={{ flex: "1 1 300px" }} /></div>\n',
    })
    const r = run(dir)
    expect(r.code).toBe(1)
    expect(r.out).toContain(path.join("components", "Band.tsx") + ":1")
    expect(r.out).toContain("rpc-band")
  })

  it("(2) reds on the Tailwind responsive-direction arm (the header used to say it was not parsed)", () => {
    const dir = fixture({
      "app/tokens.css": GLOBAL_CSS, // keeps the positive control satisfied
      "components/Row.tsx":
        'export const Row = () => <div className="flex flex-col sm:flex-row"><span style={{ flex: "1 1 12rem" }} /></div>\n',
    })
    const r = run(dir)
    expect(r.code).toBe(1)
    expect(r.out).toContain(path.join("components", "Row.tsx"))
    expect(r.out).toContain("tailwind responsive flex-direction utility")
  })

  it("(3) passes a keyword or unitless basis under the same flip (no false positive)", () => {
    const dir = fixture({
      "app/tokens.css": GLOBAL_CSS,
      "components/Band.tsx":
        'export const Band = () => <div className="rpc-band"><input style={{ flex: "1 1 auto" }} /><b style={{ flex: 1 }} /></div>\n',
    })
    const r = run(dir)
    expect(r.code).toBe(0)
    expect(r.out).toContain("0 co-occurrence(s)")
  })

  it("(4) passes the bad expression when it only appears in a COMMENT (the fix documents it)", () => {
    const dir = fixture({
      "app/tokens.css": GLOBAL_CSS,
      "components/Band.tsx":
        '// was: style={{ flex: "1 1 300px" }} — a width basis that became a height\nexport const Band = () => <div className="rpc-band" />\n',
    })
    expect(run(dir).code).toBe(0)
  })

  it("(5) reds as INSTRUMENT BROKEN, not clean, when it can parse no media query at all", () => {
    const dir = fixture({
      "components/Band.tsx": 'export const Band = () => <input style={{ flex: "1 1 300px" }} />\n',
    })
    const r = run(dir)
    expect(r.code).toBe(1)
    expect(r.out).toContain("INSTRUMENT BROKEN")
    expect(r.out).not.toContain("] clean")
  })

  it("(6) finds a column flip nested past a first inner rule (the 08-22 first-cut defect)", () => {
    // The first cut closed @media at the first `}` — this flip sits after one.
    const css = "@media (max-width: 640px) {\n  .a { color: red; }\n  .rpc-late { flex-direction: column; }\n}\n"
    const dir = fixture({
      "app/tokens.css": css,
      "components/Late.tsx":
        'export const Late = () => <div className="rpc-late"><i style={{ flex: "0 0 240px" }} /></div>\n',
    })
    const r = run(dir)
    expect(r.code).toBe(1)
    expect(r.out).toContain("rpc-late")
  })

  it("(7) passes on the real tree and states what it inspected", () => {
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
    })
    expect(r.status).toBe(0)
    const m = /inspected (\d+) file\(s\); (\d+) media block\(s\); (\d+) class\(es\)/.exec(r.stdout)
    expect(m).not.toBeNull()
    // Floors, not pins (1,379 files / 77 blocks / 4 classes on 2026-10-02): a guard that
    // stops reading the tree must not pass.
    expect(Number(m![1])).toBeGreaterThan(500)
    expect(Number(m![2])).toBeGreaterThan(20)
    expect(Number(m![3])).toBeGreaterThan(1)
  })
})
