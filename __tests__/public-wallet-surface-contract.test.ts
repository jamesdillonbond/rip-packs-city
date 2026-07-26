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

function publicPageRegexSource(): string {
  const m = proxySrc.match(/\/\^\\\/\(\?:nba-top-shot\|[^\n]*/)
  if (!m) throw new Error("public collection-page regex not found in proxy.ts")
  return m[0]
}

describe("public wallet surfaces are reachable end to end", () => {
  it("parses the allowlist out of proxy.ts", () => {
    const apis = publicReadApis()
    expect(apis.length).toBeGreaterThan(10)
    // Sanity: a route we know is public, and one we know is not.
    expect(apis).toContain("/api/sniper-feed")
    expect(apis).not.toContain("/api/wallet-cost-basis")
  })

  for (const { page, api } of WALLET_SURFACES) {
    it(`${page} is public, so ${api} must be too`, () => {
      const [, collection, tab] = page.split("/")
      const pageRegex = publicPageRegexSource()
      expect(pageRegex, `${collection} missing from the public page regex`).toContain(collection)
      expect(pageRegex, `${tab} tab missing from the public page regex`).toContain(tab)
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
