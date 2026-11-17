import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import nextConfig from "../next.config"

// Guard for the DEP0169 fix (2026-10-03). The Flow SDK's HTTP transport fetches
// through cross-fetch → node-fetch@2, whose parseURL() calls the deprecated
// `url.parse()` on every request. Node 24 only emits DEP0169 when that caller is
// OUTSIDE node_modules, so the warning (Vercel's top runtime-error group) came
// from Next bundling node-fetch into .next/server. Externalizing it is the fix;
// if it is ever dropped from this list the noise returns with nothing failing.

describe("next.config externalizes node-fetch", () => {
  it("lists node-fetch in serverExternalPackages", () => {
    expect(nextConfig.serverExternalPackages ?? []).toContain("node-fetch")
  })

  it("the premise still holds: the installed node-fetch calls Url.parse", () => {
    // If node-fetch stops calling url.parse (a v3 bump, or cross-fetch moving to
    // native fetch), this entry is dead weight — re-evaluate, don't just re-pin.
    const pkgDir = dirname(require.resolve("node-fetch/package.json"))
    const lib = readFileSync(join(pkgDir, "lib", "index.js"), "utf8")
    expect(lib).toMatch(/const parse_url = Url\.parse;/)
    expect(lib).toMatch(/return parse_url\(urlStr\);/)
  })
})
