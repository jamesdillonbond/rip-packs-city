// 2026-09-25 — `/panini-blockchain/:path*` redirected to `/nba-top-shot/overview`
// (an audit's "neutralize the dead route", 2026-05-20). A Panini URL answered
// with NBA Top Shot is the SUBSTITUTION face of the honesty rule: nothing
// fails, the subject is swapped. It bit once Panini had a real surface —
// `fullCollectionHref` routes a wallet with Panini holdings to
// /panini-blockchain/overview, which landed on Top Shot's overview.
//
// This reads every redirect out of next.config.ts and pins the property: a
// redirect whose source starts with a registry collection slug never lands on
// a DIFFERENT registry collection's slug. A dead collection route may go to its
// own tab, to an insights board about that collection, or 404 — never to
// another collection.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { COLLECTIONS } from "@/lib/collections"

const CONFIG = readFileSync(join(process.cwd(), "next.config.ts"), "utf8")

interface Redirect { source: string; destination: string }

/** Every `{ source: "...", destination: "..." }` pair declared in next.config.ts
 *  (object literals in either key order, with or without other keys). */
export function redirectsFromConfig(src: string): Redirect[] {
  const out: Redirect[] = []
  const re = /\{[^{}]*?source:\s*"([^"]+)"[^{}]*?destination:\s*"([^"]+)"[^{}]*\}/g
  for (const m of src.matchAll(re)) out.push({ source: m[1], destination: m[2] })
  return out
}

function firstSegment(path: string): string {
  return path.replace(/^\//, "").split("/")[0] ?? ""
}

describe("next.config.ts redirects never swap the collection", () => {
  const slugs = new Set(COLLECTIONS.map((c) => c.id))
  const redirects = redirectsFromConfig(CONFIG)

  it("inspects a real population of redirects", () => {
    expect(redirects.length).toBeGreaterThan(3)
    // At least one redirect is sourced from a collection slug, so the ban below
    // is not vacuous (the Panini one that seeded this file was removed 2026-09-25).
    expect(redirects.some((r) => slugs.has(firstSegment(r.source)))).toBe(true)
  })

  it("a redirect from one collection's URL never lands on another collection's URL", () => {
    const offenders = redirects
      .filter((r) => slugs.has(firstSegment(r.source)))
      .filter((r) => {
        const dst = firstSegment(r.destination)
        return slugs.has(dst) && dst !== firstSegment(r.source)
      })
      .map((r) => `${r.source} → ${r.destination}`)
    expect(offenders).toEqual([])
  })

  // ⭐ INVERTED 2026-09-25 (was: "the Panini dead route lands on the Panini
  // surface"). Panini PUBLISHED, and the whole-subtree redirect that test pinned
  // would have made it unreachable — next.config redirects run before the proxy
  // and every page. The property now: a PUBLISHED collection's URL space is never
  // swallowed whole by a redirect.
  it("no redirect swallows a PUBLISHED collection's whole URL space", () => {
    const published = new Set(COLLECTIONS.filter((c) => c.published).map((c) => c.id))
    expect(published.has("panini-blockchain")).toBe(true)
    const swallowed = redirects
      .filter((r) => /^\/[^/]+\/:path\*$/.test(r.source) && published.has(firstSegment(r.source)))
      .map((r) => `${r.source} → ${r.destination}`)
    expect(swallowed).toEqual([])
  })

  it("the scanner sees the defect it bans (planted)", () => {
    const planted = `{ source: "/panini-blockchain/:path*", destination: "/nba-top-shot/overview", permanent: false },`
    const r = redirectsFromConfig(planted)[0]
    expect(r).toEqual({ source: "/panini-blockchain/:path*", destination: "/nba-top-shot/overview" })
    expect(slugs.has(firstSegment(r.destination)) && firstSegment(r.destination) !== firstSegment(r.source)).toBe(true)
  })
})
