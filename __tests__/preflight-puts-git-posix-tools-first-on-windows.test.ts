import { describe, expect, it } from "vitest"
import { posixFirstPath } from "@/scripts/preflight.mjs"

// 2026-11-10: from PowerShell, `bash` was the WSL stub in WindowsApps and `sh`/`awk`
// were missing, so 88 shell-out tests failed locally while CI was green.
describe("preflight puts Git's POSIX tools ahead of PATH on Windows", () => {
  const winPath = "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Windows\\system32"

  it("prepends <git>\\usr\\bin and <git>\\bin ahead of the WSL bash stub", () => {
    const out = posixFirstPath(winPath, { platform: "win32", gitRoot: "C:\\Program Files\\Git" }).split(";")
    expect(out.slice(0, 2)).toEqual(["C:\\Program Files\\Git\\usr\\bin", "C:\\Program Files\\Git\\bin"])
    expect(out.indexOf("C:\\Program Files\\Git\\usr\\bin")).toBeLessThan(
      out.indexOf("C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps"),
    )
  })

  it("moves an entry already present later in PATH to the front instead of duplicating it", () => {
    const out = posixFirstPath(`${winPath};c:\\program files\\git\\usr\\bin\\`, {
      platform: "win32",
      gitRoot: "C:\\Program Files\\Git\\",
    }).split(";")
    expect(out.filter((p: string) => p.toLowerCase().startsWith("c:\\program files\\git\\usr\\bin"))).toHaveLength(1)
    expect(out[0]).toBe("C:\\Program Files\\Git\\usr\\bin")
  })

  it("NO-CHANGE CONTROL: leaves PATH untouched off Windows, or with no Git root", () => {
    expect(posixFirstPath("/usr/bin:/bin", { platform: "linux", gitRoot: "C:\\Program Files\\Git" })).toBe("/usr/bin:/bin")
    expect(posixFirstPath(winPath, { platform: "win32", gitRoot: null })).toBe(winPath)
  })
})
