import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { jsonLdScript } from "@/lib/seo/json-ld-script"

// Security audit 2026-10-25. JSON-LD is emitted as an inline <script> via
// dangerouslySetInnerHTML; bare JSON.stringify does not escape "<", so a
// database string containing "</script>" (a player, set or persona name) would
// close the element and let the rest run as HTML on our origin.

describe("jsonLdScript", () => {
  const evil = { name: '</script><script>alert(document.domain)</script>', amp: "a & b", ls: "x\u2028y" }

  it("never emits a raw < > & or line separator", () => {
    const out = jsonLdScript(evil)
    expect(out).not.toMatch(/[<>&\u2028\u2029]/)
    expect(out.toLowerCase()).not.toContain("</script")
  })

  it("round-trips to the identical object", () => {
    expect(JSON.parse(jsonLdScript(evil))).toEqual(evil)
  })

  it("handles undefined without throwing", () => {
    expect(jsonLdScript(undefined)).toBe("null")
  })
})

describe("no inline script serialises JSON without jsonLdScript (tree walk, ban at zero)", () => {
  const BARE = /__html:\s*JSON\.stringify\(/
  const files = execFileSync("git", ["ls-files", "-z", "--", "app", "components", "lib"], { encoding: "utf8" })
    .split("\0")
    .filter((f) => /\.(tsx|ts)$/.test(f))

  it("walks the tree (not vacuous)", () => {
    expect(files.length).toBeGreaterThan(500)
    const users = files.filter((f) => readFileSync(f, "utf8").includes("__html: jsonLdScript("))
    expect(users.length).toBeGreaterThan(50)
  })

  it("finds zero bare `__html: JSON.stringify(` sites", () => {
    expect(files.filter((f) => BARE.test(readFileSync(f, "utf8")))).toEqual([])
  })

  it("the pattern fires on the shape it bans (planted)", () => {
    expect(BARE.test("dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}")).toBe(true)
    expect(BARE.test("__html:\n  JSON.stringify(x)")).toBe(true)
    expect(BARE.test("__html: jsonLdScript(jsonLd)")).toBe(false)
  })
})
