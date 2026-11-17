// 2026-11-07 review: the layout, generateMetadata and the page each run the
// Top Shot alias / fossil redirect lookup for the same slug in one request, so
// an uncached helper made up to three service-role probes per edition view.
// Both exports must be React cache()'d (one probe per request), like
// fetchEntityDetailRaw beside them.
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const CASES = [
  ["lib/edition/alias-redirect.ts", "lookupTopShotEditionAliasRedirect"],
  ["lib/edition/fossil-redirect.ts", "lookupTopShotFossilRedirect"],
] as const

describe("edition redirect lookups are request-cached", () => {
  for (const [file, name] of CASES) {
    it(`${name} is exported through React cache()`, () => {
      const src = stripComments(readFileSync(file, "utf8"))
      expect(src).toMatch(/import\s*\{\s*cache\s*\}\s*from\s*"react"/)
      expect(src).toMatch(new RegExp(`export const ${name} = cache\\(`))
      expect(src).not.toMatch(new RegExp(`export async function ${name}\\b`))
    })
  }
})
