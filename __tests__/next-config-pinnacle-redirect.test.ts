import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pathToRegexp } = require("next/dist/compiled/path-to-regexp")

// Guard for the /pinnacle/* canonicalization redirect (2026-07-25).
//
// `pinnacle` is not a registered collection slug — the canonical one is
// `disney-pinnacle` — but app/(collections)/[collection]/* still matched
// /pinnacle/<tab>, rendering Disney Pinnacle data under NBA Top Shot chrome.
// The fix redirects the feature-tab/entity paths to /disney-pinnacle/*.
//
// The load-bearing constraint: /pinnacle/moment/<render_id> is a REAL page
// (app/pinnacle/moment/[id]) with ~2,412 URLs in the sitemap, so the redirect
// must NOT be a blanket /pinnacle/:path* rule. This test reads the actual
// pattern out of next.config.ts and proves that.

const CONFIG = readFileSync(join(__dirname, "..", "next.config.ts"), "utf8")

function pinnacleRedirectSource(): string {
  const m = CONFIG.match(/source:\s*\n?\s*"(\/pinnacle\/:page\([^"]*)"/)
  expect(m, "next.config.ts must declare a /pinnacle/:page(...) redirect source").toBeTruthy()
  return (m as RegExpMatchArray)[1]
}

describe("next.config.ts /pinnacle canonicalization redirect", () => {
  const src = pinnacleRedirectSource()
  const re = pathToRegexp(src, [])

  it("redirects the mis-branded feature tabs", () => {
    for (const p of [
      "/pinnacle/overview",
      "/pinnacle/collection",
      "/pinnacle/market",
      "/pinnacle/sniper",
      "/pinnacle/analytics",
    ]) {
      expect(re.test(p), `${p} should redirect to /disney-pinnacle/...`).toBe(true)
    }
  })

  it("leaves the sitemap'd per-pin pages alone", () => {
    for (const p of [
      "/pinnacle/moment/GEN-DPIN-SIMB-S0",
      "/pinnacle/moment/OEV1-SWHM-KYLO-S5",
      "/pinnacle/moment/STAR-OEV1-SWHM:Digital%20Display:1",
    ]) {
      expect(re.test(p), `${p} must keep resolving (2,412 indexed URLs)`).toBe(false)
    }
  })

  it("does not claim the bare /pinnacle route (app/pinnacle/page.tsx owns it)", () => {
    expect(re.test("/pinnacle")).toBe(false)
  })

  it("points at the canonical disney-pinnacle slug and is permanent", () => {
    const i = CONFIG.indexOf(src)
    const block = CONFIG.slice(i, i + 400)
    expect(block).toContain("/disney-pinnacle/:page/:rest*")
    expect(block).toContain("permanent: true")
  })
})
