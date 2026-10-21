// __tests__/robots-blocks-rsc-flight-and-analytics.test.ts
//
// Search Console Crawl stats (2026-10-21, 90 d): 45% of Googlebot's 128K
// requests were Next.js RSC flight payloads (`?_rsc=`) and 14% the Vercel
// Analytics beacon — 59% of the crawl spent on URLs that are not documents.
// app/robots.ts now disallows both. This pins:
//   1. the blocks exist (both `?_rsc=` and `&_rsc=` forms, both beacon prefixes);
//   2. MIRROR — they do not block a document: under Google's longest-match
//      rule a real page URL, its static chunks, its images and its og:image
//      all stay crawlable.
// Matching implements Google's robots.txt semantics (prefix match, `*`
// wildcard, `$` anchor, longest match wins, Allow wins a tie) so the mirror
// is evaluated the way Googlebot evaluates it, not by string inclusion.

import { describe, expect, it } from "vitest"
import robots from "@/app/robots"

type Rule = { allow?: string | string[]; disallow?: string | string[]; userAgent?: string | string[] }

const star = (() => {
  const r = robots().rules
  const list = (Array.isArray(r) ? r : [r]) as Rule[]
  const rule = list.find((x) => (Array.isArray(x.userAgent) ? x.userAgent : [x.userAgent]).includes("*"))
  if (!rule) throw new Error("no * rule")
  const arr = (v: string | string[] | undefined) => (v == null ? [] : Array.isArray(v) ? v : [v])
  return { allow: arr(rule.allow), disallow: arr(rule.disallow) }
})()

function toRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$")
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")
  return new RegExp("^" + body + (anchored ? "$" : ""))
}

/** Google semantics: longest matching pattern wins; Allow wins a tie. */
function allowed(pathWithQuery: string): boolean {
  let best: { len: number; allow: boolean } | null = null
  for (const [list, allow] of [[star.allow, true], [star.disallow, false]] as const) {
    for (const p of list) {
      if (!toRegex(p).test(pathWithQuery)) continue
      if (!best || p.length > best.len || (p.length === best.len && allow)) best = { len: p.length, allow }
    }
  }
  return best ? best.allow : true
}

describe("robots blocks RSC flight payloads and the analytics beacon", () => {
  it("the four rules are present", () => {
    for (const p of ["/*?_rsc=", "/*&_rsc=", "/15dcfe7049762b91/", "/7485f3c010ece1f3/"]) {
      expect(star.disallow).toContain(p)
    }
  })

  it("blocks RSC payload URLs in both query positions, and the beacons", () => {
    expect(allowed("/insights/deals?_rsc=pGlJ5xH9aSgMgLI4")).toBe(false)
    expect(allowed("/?_rsc=WwDDH2lD_2qkkEDP")).toBe(false)
    expect(allowed("/nba-top-shot/edition/90%3A3571?tab=sales&_rsc=abc")).toBe(false)
    expect(allowed("/15dcfe7049762b91/view")).toBe(false)
    expect(allowed("/15dcfe7049762b91/script.js")).toBe(false)
    expect(allowed("/7485f3c010ece1f3/script.js")).toBe(false)
  })

  it("MIRROR: documents and the resources they render with stay crawlable", () => {
    for (const p of [
      "/",
      "/insights/deals",
      "/nba-top-shot/edition/90%3A3571",
      "/panini-blockchain/edition/packcard-1780_338213_9299197_7",
      "/panini-blockchain/player/allen-iverson",
      "/nba-top-shot/edition/90%3A3571?tab=sales",
      "/_next/static/chunks/app/layout-abc123.js",
      "/_next/image?url=%2Fx.png&w=640&q=75",
      "/api/og/edition?collection=nba-top-shot&slug=90%3A3571",
      "/api/public/pinnacle-image/GEN-DPIN-SIMB-S0",
      "/profile/webz_80",
    ]) {
      expect(allowed(p), p).toBe(true)
    }
  })

  it("the matcher itself is not vacuous (planted cases)", () => {
    expect(allowed("/api/private-thing")).toBe(false)
    expect(allowed("/nba-top-shot/collection?wallet=0xabc")).toBe(false)
    expect(allowed("/api/og/x")).toBe(true)
  })
})
