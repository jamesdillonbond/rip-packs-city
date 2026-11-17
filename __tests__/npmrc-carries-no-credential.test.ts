import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

// `.npmrc` was gitignored (the usual home of `_authToken`) until the 2026-11-04 CISO
// pass tracked it for `ignore-scripts=true` + `min-release-age=7`. A tracked .npmrc is
// a place a credential can be committed by habit, so every non-comment line must be
// one of the keys below — nothing registry-scoped, nothing auth-shaped.
const ALLOWED_KEYS = new Set(["ignore-scripts", "min-release-age", "engine-strict", "save-exact", "fund", "audit"])

function entries(src: string): Array<[string, string]> {
  return src
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith(";"))
    .map((l) => {
      const i = l.indexOf("=")
      return [i < 0 ? l : l.slice(0, i).trim(), i < 0 ? "" : l.slice(i + 1).trim()]
    })
}

describe(".npmrc", () => {
  const src = readFileSync(".npmrc", "utf8")
  const kv = entries(src)

  it("keeps the two supply-chain settings the CISO pass tracked it for", () => {
    const m = new Map(kv)
    expect(m.get("ignore-scripts")).toBe("true")
    expect(Number(m.get("min-release-age"))).toBeGreaterThanOrEqual(1)
  })

  it("carries no credential or registry-scoped key (allow-list, not a pattern)", () => {
    for (const [k] of kv) {
      expect(ALLOWED_KEYS.has(k), `unexpected .npmrc key: ${k}`).toBe(true)
    }
  })

  it("the allow-list would refuse an auth token (planted)", () => {
    const planted = entries("ignore-scripts=true\n//registry.npmjs.org/:_authToken=npm_abc\n")
    expect(planted.some(([k]) => !ALLOWED_KEYS.has(k))).toBe(true)
  })
})
