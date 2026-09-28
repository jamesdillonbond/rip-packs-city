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
// The fix 308s the feature-tab/entity paths to /disney-pinnacle/*.
//
// The load-bearing constraint: /pinnacle/moment/<render_id> is a REAL page
// (app/pinnacle/moment/[id]) with ~2,412 URLs in the sitemap, so the redirect
// must NOT be a blanket /pinnacle/:path* rule. This test reads the actual
// patterns out of next.config.ts and proves that.

const CONFIG = readFileSync(join(__dirname, "..", "next.config.ts"), "utf8")

/** Every `/pinnacle/:page(...)` redirect source declared in next.config.ts. */
function pinnacleRedirectSources(): string[] {
  const found = Array.from(CONFIG.matchAll(/"(\/pinnacle\/:page\([^"]*)"/g)).map((m) => m[1])
  expect(found.length, "next.config.ts must declare /pinnacle/:page(...) redirects").toBeGreaterThan(0)
  return found
}

/** True when ANY of the pinnacle redirect rules matches this path. */
function matchesAny(path: string): boolean {
  return pinnacleRedirectSources().some((s) => pathToRegexp(s, []).test(path))
}

describe("next.config.ts /pinnacle canonicalization redirect", () => {
  it("redirects the mis-branded feature tabs", () => {
    for (const p of [
      "/pinnacle/overview",
      "/pinnacle/collection",
      "/pinnacle/market",
      "/pinnacle/sniper",
      "/pinnacle/analytics",
    ]) {
      expect(matchesAny(p), `${p} should redirect to /disney-pinnacle/...`).toBe(true)
    }
  })

  it("redirects nested entity paths too", () => {
    for (const p of ["/pinnacle/edition/262:8754", "/pinnacle/set/some-set", "/pinnacle/pack/dist/16"]) {
      expect(matchesAny(p), `${p} should redirect`).toBe(true)
    }
  })

  it("leaves the sitemap'd per-pin pages alone", () => {
    for (const p of [
      "/pinnacle/moment/GEN-DPIN-SIMB-S0",
      "/pinnacle/moment/OEV1-SWHM-KYLO-S5",
      "/pinnacle/moment/STAR-OEV1-SWHM:Digital%20Display:1",
    ]) {
      expect(matchesAny(p), `${p} must keep resolving (2,412 indexed URLs)`).toBe(false)
    }
  })

  it("does not claim the bare /pinnacle route (app/pinnacle/page.tsx owns it)", () => {
    expect(matchesAny("/pinnacle")).toBe(false)
  })

  it("keeps a bare-tab rule first so a plain tab is ONE hop, not a trailing-slash chain", () => {
    // `/disney-pinnacle/:page/:rest*` compiles an empty rest to a trailing slash,
    // which costs a second 308. A dedicated no-sub-path rule must come first.
    const sources = pinnacleRedirectSources()
    const bare = sources.filter((s) => !s.includes("/:rest"))
    expect(bare.length, "expected one /pinnacle/:page(...) rule with no /:rest segment").toBe(1)
    expect(sources.indexOf(bare[0])).toBe(0)
    expect(CONFIG).toContain('destination: "/disney-pinnacle/:page",')
  })

  it("points at the canonical disney-pinnacle slug and is permanent", () => {
    for (const src of pinnacleRedirectSources()) {
      const block = CONFIG.slice(CONFIG.indexOf(src), CONFIG.indexOf(src) + 400)
      expect(block).toContain("/disney-pinnacle/:page")
      expect(block).toContain("permanent: true")
    }
  })
})

// 2026-09-27: /disney-pinnacle/edition/<id> was a 200 placeholder + client hop
// (the page's permanentRedirect runs inside a streamed render). It is a real 308
// to the pin page now, evaluated from next.config's own redirects().
describe("next.config.ts /disney-pinnacle/edition → /pinnacle/moment", () => {
  it("is a permanent redirect to the pin page, and loops into nothing", async () => {
    const mod = await import("../next.config")
    const cfg = (mod.default ?? mod) as { redirects: () => Promise<Array<{ source: string; destination: string; permanent: boolean; has?: unknown[] }>> }
    const rules = await cfg.redirects()
    const rule = rules.find((r) => r.source === "/disney-pinnacle/edition/:id")
    expect(rule, "a /disney-pinnacle/edition/:id rule must exist").toBeTruthy()
    expect(rule!.destination).toBe("/pinnacle/moment/:id")
    expect(rule!.permanent).toBe(true)
    // No unconditional rule may match the destination (a host-conditioned rule —
    // the vercel.app → www hop — never applies on the canonical host).
    const dest = "/pinnacle/moment/OEEV1-EXPD-MINN-E2"
    const reMatches = rules.filter((r) => !r.has && pathToRegexp(r.source, []).test(dest))
    expect(reMatches).toEqual([])
    // CONTROL: other collections' edition pages are untouched.
    expect(rules.some((r) => !r.has && pathToRegexp(r.source, []).test("/nba-top-shot/edition/98:3150"))).toBe(false)
  })
})
