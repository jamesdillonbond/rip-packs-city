import { describe, it, expect } from "vitest"

// ─────────────────────────────────────────────────────────────────────────────
// proxy.ts — which PAGE routes are metered by the anonymous burst cap.
//
// Until 2026-08-07 the rate limiter in proxy() was `/api/`-only, so every
// server-rendered, DB-backed page route was completely unmetered. Measured
// 2026-08-06: ~78k page requests in 12h from the post-2026-08-01 AI-crawler
// unblock, none of it rate limited, against a Supabase Micro instance — the
// proximate cause of the pooler exhaustion, the 504s on the scheduled layer,
// and the statement-timeout 500s on the pack-distribution pages.
//
// `isRateLimitedPageRoute(pathname)` is the scope of that cap. It is a
// deliberate ALLOWLIST of expensive surfaces, not a catch-all: metering cheap
// or static pages (/, /login, /pricing) buys nothing and risks throttling the
// funnel. A diff that flips a row here changes who gets a 429, so the table is
// the contract.
//
// Two invariants this file exists to protect:
//   · cheap/marketing/auth pages stay UNMETERED (a 429 on /login is a bug),
//   · the enumerated DB-backed surfaces stay METERED (that's the whole point).
//
// The cap itself is additionally scoped at the call site in proxy() to
// GET/HEAD + anonymous only; `hasAuthCookie` pins the signed-in exemption.
// ─────────────────────────────────────────────────────────────────────────────

import { isRateLimitedPageRoute, hasAuthCookie } from "@/proxy"

type Row = [path: string, expected: boolean, why?: string]

const ROWS: Row[] = [
  // ── Metered: the heavy, DB-backed public surfaces the crawl actually hit ──
  ["/nba-top-shot/collection", true, "19,658 hits/12h, all cache=MISS"],
  ["/nba-top-shot/edition/257:8867", true, "26,503 hits/12h — heaviest route"],
  ["/nfl-all-day/edition/1707", true],
  ["/nfl-all-day/pack/dist/1029", true, "the route throwing 97% of all 500s"],
  ["/nba-top-shot/player/lebron-james", true],
  ["/nba-top-shot/team/portland-trail-blazers", true],
  ["/nba-top-shot/set/base-set", true],
  ["/nba-top-shot/series/series-1", true],
  ["/pinnacle/moment/12345", true, "collection-scoped moment tab"],
  ["/profile/jamesdillonbond", true, "14,652 hits/12h, force-dynamic"],
  ["/profile/0xbd94cade097e50ac", true, "the 0x… enumeration"],
  ["/moment/6bfd5eb2-3708-4f7c-94b4-ce84de8a84c6", true, "top-level, force-dynamic"],
  ["/special-serial-owners", true],

  // ── Unmetered: cheap, static, or funnel-critical ────────────────────────
  ["/", false, "marketing landing — never throttle the front door"],
  ["/login", false, "a 429 here locks people out of their own account"],
  ["/pricing", false],
  ["/about", false],
  ["/insights", false, "hub page, not per-entity"],
  ["/insights/candy-mlb", false, "single board, not an enumerable entity space"],
  ["/dashboard", false, "signed-in only; never reached anonymously"],
  ["/share/0xbd94cade097e50ac", false, "share funnel — must stay frictionless"],
  ["/nba-top-shot/overview", false, "cheap tab, not an entity page"],
  ["/nba-top-shot/analytics", false],
  ["/nba-top-shot/sniper", false],

  // ── Shape guards ─────────────────────────────────────────────────────────
  ["/edition/257:8867", false, "one segment deep — not a collection-scoped page"],
  ["/collection", false, "bare word at root is not /<collection>/collection"],
  ["", false, "empty path must not throw or match"],
]

describe("isRateLimitedPageRoute — anonymous page burst-cap scope", () => {
  for (const [path, expected, why] of ROWS) {
    const label = `${expected ? "METERED " : "unmetered"}  ${path || "(empty)"}${why ? `  — ${why}` : ""}`
    it(label, () => {
      expect(isRateLimitedPageRoute(path)).toBe(expected)
    })
  }

  it("never throws on odd input", () => {
    for (const p of ["/", "//", "///", "/a/", "/a//b"]) {
      expect(() => isRateLimitedPageRoute(p)).not.toThrow()
    }
  })
})

// Minimal NextRequest-shaped stub — we only touch `.cookies.getAll()`.
function reqWithCookies(names: string[]): any {
  return { cookies: { getAll: () => names.map((name) => ({ name, value: "x" })) } }
}

describe("hasAuthCookie — signed-in exemption from the anonymous cap", () => {
  it("true for the Supabase SSR auth cookie", () => {
    expect(hasAuthCookie(reqWithCookies(["sb-bxcqstmqfzmuolpuynti-auth-token"]))).toBe(true)
  })

  it("true for the chunked variant Supabase writes on large sessions", () => {
    expect(hasAuthCookie(reqWithCookies(["sb-bxcqstmqfzmuolpuynti-auth-token.0"]))).toBe(true)
  })

  it("false when no cookies at all — the anonymous crawler case", () => {
    expect(hasAuthCookie(reqWithCookies([]))).toBe(false)
  })

  it("false for the allow-list cache cookie alone", () => {
    // rpc_al_check is written AFTER the auth gate passes; on its own it must
    // not exempt a request, or a stale cookie would buy unmetered access.
    expect(hasAuthCookie(reqWithCookies(["rpc_al_check"]))).toBe(false)
  })

  it("false for unrelated analytics/consent cookies", () => {
    expect(hasAuthCookie(reqWithCookies(["_vercel_jwt", "sb-provider-token-hint"]))).toBe(false)
  })
})

// ── 2026-09-06: media proxies and signed-in readers get their own API budget ──
// A 510-page QA sweep from one IP spent the 60/min API budget on per-page
// chrome (/api/profile/me, /api/telemetry, /api/track-funnel) and on proxied
// IMAGES (/api/public/pinnacle-image → 429 → a blank tile nothing reports).
import { apiRateLimitFor, isMediaProxyPath } from "@/proxy"

describe("apiRateLimitFor — images are tiles, not API calls; a signed-in reader is not a crawler", () => {
  it("routes every media proxy to the media bucket at a 10× ceiling", () => {
    for (const p of [
      "/api/public/pinnacle-image/OEV1-CARS-GUID-S2",
      "/api/public/ipfs-media/bafy123",
      "/api/public/avatar-media",
      "/api/badge-image",
      "/api/moment-thumbnail",
      "/api/og/profile/x",
    ]) {
      expect(isMediaProxyPath(p)).toBe(true)
      expect(apiRateLimitFor(p, false)).toEqual({ max: 600, bucket: "media" })
      expect(apiRateLimitFor(p, true)).toEqual({ max: 600, bucket: "media" })
    }
  })

  it("a prefix match must be on a path boundary — /api/ogx is not /api/og", () => {
    expect(isMediaProxyPath("/api/ogx")).toBe(false)
    expect(isMediaProxyPath("/api/public/pinnacle-imagery")).toBe(false)
  })

  it("keeps the anonymous 60/min for ordinary API calls and gives a signed-in reader 240", () => {
    expect(apiRateLimitFor("/api/profile/me", false)).toEqual({ max: 60, bucket: "api" })
    expect(apiRateLimitFor("/api/profile/me", true)).toEqual({ max: 240, bucket: "api" })
    expect(apiRateLimitFor("/api/telemetry", false).max).toBe(60)
  })
})
