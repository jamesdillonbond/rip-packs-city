import { describe, it, expect } from "vitest"
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"

// Windows PowerShell 5.1 (the `powershell.exe` every scheduled task here runs) reads a .ps1 WITHOUT a
// byte-order mark as Windows-1252, not UTF-8. A UTF-8 em dash (E2 80 94) then decodes as "â€”", and
// 0x94 in 1252 is a right double quote — inside a string literal that closes the string and the
// script dies with a parse error before running a line. Measured 2026-10-02:
// scripts/panini-schedule-harden.ps1 exited 1 on Trevor's box and changed no task until its 4
// non-ASCII characters were replaced. Non-ASCII inside a comment is survivable today, but one edit
// moves it into a string, so the rule is a ban at zero: ASCII only, unless the file carries a BOM.

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

/** Offending (line, codepoint) pairs for one file's bytes; [] when the file is safe for PS 5.1. */
export function ps1EncodingProblems(bytes: Buffer): Array<{ line: number; char: string }> {
  if (bytes.subarray(0, 3).equals(BOM)) return []
  const out: Array<{ line: number; char: string }> = []
  bytes.toString("utf8").split("\n").forEach((l, i) => {
    for (const ch of l) if (ch.codePointAt(0)! > 0x7e && ch !== "\r") out.push({ line: i + 1, char: ch })
  })
  return out
}

const files = execSync("git ls-files '*.ps1' '*.psm1'", { encoding: "utf8" }).split("\n").filter(Boolean)

describe("PowerShell scripts parse under Windows PowerShell 5.1", () => {
  it("inspects the tracked .ps1 files (not vacuous)", () => {
    expect(files.length).toBeGreaterThanOrEqual(8)
  })

  it("every tracked .ps1 is pure ASCII or starts with a UTF-8 BOM", () => {
    const bad = files
      .map((f) => ({ f, problems: ps1EncodingProblems(readFileSync(f)) }))
      .filter((x) => x.problems.length > 0)
      .map((x) => `${x.f}: ${x.problems.slice(0, 3).map((p) => `line ${p.line} U+${p.char.codePointAt(0)!.toString(16).toUpperCase()}`).join(", ")}`)
    expect(bad, "replace the characters with ASCII (or save the file as UTF-8 with BOM)").toEqual([])
  })

  it("planted defect: an em dash in a string is caught; the same file with a BOM, or ASCII, passes", () => {
    const planted = Buffer.from('Write-Host "a — b"\n', "utf8")
    expect(ps1EncodingProblems(planted)).toEqual([{ line: 1, char: "—" }])
    expect(ps1EncodingProblems(Buffer.concat([BOM, planted]))).toEqual([])
    expect(ps1EncodingProblems(Buffer.from('Write-Host "a - b"\r\n', "utf8"))).toEqual([])
  })
})
