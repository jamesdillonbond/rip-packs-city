import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// Public wallet-surface contract.
//
// A wallet-lookup page is the product's wedge: an anonymous visitor pastes an
// address and immediately sees value, with no account. That only works if the
// page AND the API it calls are both reachable anonymously. Gate either half
// and the surface still LOOKS public — it renders, it shows an input — but the
// paste bounces to /login, which is worse than not shipping the input at all.
//
// This has now bitten twice: /overview pointed anonymous users at the
// auth-gated /dashboard, and /disney-pinnacle/collection sat in proxy.ts's
// public PAGE regex for months while /api/pinnacle-wallet — the ONLY API it
// calls — was missing from PUBLIC_READ_APIS. Nothing caught either, because
// each half is individually correct.
//
// So this test pins the PAIRING rather than either half: every public wallet
// page must have its data route in the public read set. It reads proxy.ts as
// source because the gate helper isn't exported and the value of the assertion
// is precisely that it survives a refactor of that file's internals.
// ─────────────────────────────────────────────────────────────────────────────

const proxySrc = readFileSync(join(process.cwd(), "proxy.ts"), "utf8")

/** Public wallet-lookup page -> the API route it cannot function without. */
const WALLET_SURFACES: Array<{ page: string; api: string }> = [
  { page: "/disney-pinnacle/collection", api: "/api/pinnacle-wallet" },
  { page: "/nba-top-shot/collection", api: "/api/collection-moments" },
]

function publicReadApis(): string[] {
  const m = proxySrc.match(/const PUBLIC_READ_APIS = new Set\(\[([\s\S]*?)\]\)/)
  if (!m) throw new Error("PUBLIC_READ_APIS set not found in proxy.ts — did it get renamed?")
  return Array.from(m[1].matchAll(/"([^"]+)"/g)).map((x) => x[1])
}

/**
 * EVERY collection-path regex in proxy.ts, not the first one that looks right.
 *
 * 🚨 THIS USED TO TAKE THE FIRST MATCH AND IT WENT RED ON A CORRECT CHANGE.
 * On 2026-09-04 the five collection ROOTS became public, which added a SECOND
 * regex of the same shape (`…|ufc)$/`) ABOVE the tab one — so `.match()`
 * returned the roots regex, `toContain("collection")` failed, and the guard
 * reported a gating regression that had not happened: `/nba-top-shot/collection`
 * was public before the change and public after it. A guard that names the
 * wrong cause is worse than one that stays quiet.
 *
 * ⭐ THE FIX IS NOT "MATCH THE RIGHT ONE", IT IS "STOP ASSERTING ON SOURCE
 * SHAPE". The property is *can an anonymous crawler fetch this page*, and
 * matching the path against the collected regexes answers that question
 * directly — so adding, splitting or reordering a regex in proxy.ts cannot red
 * this file again unless the PAGE actually stops being public.
 */
function publicPageRegexSources(): string[] {
  const found = Array.from(proxySrc.matchAll(/\/\^\\\/\(\?:nba-top-shot\|[^\n]*?\/\.test\(pathname\)/g)).map(
    (m) => m[0],
  )
  if (found.length === 0) throw new Error("public collection-page regex not found in proxy.ts")
  return found
}

/** Does any of proxy.ts's collection regexes admit this exact path? */
function pageIsAllowedByARegex(pathname: string): boolean {
  return publicPageRegexSources().some((src) => {
    const body = src.match(/^\/(.*)\/\.test\(pathname\)$/)
    if (!body) return false
    return new RegExp(body[1].replace(/\/$/, "")).test(pathname)
  })
}

describe("public wallet surfaces are reachable end to end", () => {
  it("parses the allowlist out of proxy.ts", () => {
    const apis = publicReadApis()
    expect(apis.length).toBeGreaterThan(10)
    // Sanity: a route we know is public, and one we know is not.
    expect(apis).toContain("/api/sniper-feed")
    expect(apis).not.toContain("/api/wallet-cost-basis")
  })

  it("the page matcher can still say NO (guards the guard)", () => {
    // Without this, `pageIsAllowedByARegex` returning true unconditionally —
    // a broken regex reconstruction, say — would make every case above pass
    // while measuring nothing. Two negatives: a tab that does not exist, and a
    // collection that is deliberately not published.
    expect(pageIsAllowedByARegex("/nba-top-shot/not-a-real-tab")).toBe(false)
    expect(pageIsAllowedByARegex("/panini/collection")).toBe(false)
    // ...and a positive, so a regex that matches NOTHING is caught too.
    expect(pageIsAllowedByARegex("/nba-top-shot/collection")).toBe(true)
  })

  for (const { page, api } of WALLET_SURFACES) {
    it(`${page} is public, so ${api} must be too`, () => {
      expect(
        pageIsAllowedByARegex(page),
        `${page} is not admitted by any public collection-page regex in proxy.ts — ` +
          `the page itself now bounces an anonymous visitor to /login`,
      ).toBe(true)
      expect(
        publicReadApis(),
        `${page} renders anonymously but ${api} is gated — the wallet paste will bounce to /login`,
      ).toContain(api)
    })
  }

  it("keeps write-capable and session-scoped routes OUT of the public set", () => {
    const apis = publicReadApis()
    // Cost basis is per-user purchase history, not public market data.
    expect(apis).not.toContain("/api/wallet-cost-basis")
    // No /api/admin or /api/cron route may ever appear here.
    expect(apis.filter((a) => a.startsWith("/api/admin") || a.startsWith("/api/cron"))).toEqual([])
  })
})
