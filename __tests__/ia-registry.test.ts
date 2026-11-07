import { describe, it, expect } from "vitest"
import { existsSync } from "node:fs"
import path from "node:path"
import { IA_GROUPS, MOBILE_GROUP_IDS, resolveHref, groupForPath, visibleItems, DEFAULT_COLLECTION } from "@/lib/ia"
import { isPublicPath } from "@/proxy"
import { publishedCollections } from "@/lib/collections"

// IA Phase 2 (2026-11-06): one registry feeds the header, the mobile bar, the
// footer and the dashboard tools line. These pins hold the registry itself to
// the rules in docs/strategy/features/information-architecture-2026-11-06.md.

const ROOT = process.cwd()
/** Does a route file exist for this app path? (`{collection}` → the shared segment.) */
function routeExists(href: string): boolean {
  const p = href.split("?")[0]
  if (p.includes("{collection}")) {
    const tail = p.replace("/{collection}", "")
    return existsSync(path.join(ROOT, "app/(collections)/[collection]", tail, "page.tsx"))
  }
  const direct = path.join(ROOT, "app", p, "page.tsx")
  if (existsSync(direct)) return true
  // route groups: app/(group)/<path>/page.tsx
  const groupHit = ["(analytics)", "(collections)"].some((g) => existsSync(path.join(ROOT, "app", g, p, "page.tsx")))
  if (groupHit) return true
  // dynamic segment one level up, e.g. /trophy-challenges/dame-time → [slug]
  const parts = p.split("/").filter(Boolean)
  if (parts.length >= 2) {
    const dir = path.join(ROOT, "app", ...parts.slice(0, -1))
    if (existsSync(dir)) {
      const dyn = ["[slug]", "[id]", "[username]", "[code]"].some((d) => existsSync(path.join(dir, d, "page.tsx")))
      if (dyn) return true
    }
  }
  // a collection id as the first segment (e.g. /nba-top-shot/fast-break)
  if (parts.length === 2 && publishedCollections().some((c) => c.id === parts[0])) {
    return existsSync(path.join(ROOT, "app/(collections)/[collection]", parts[1], "page.tsx"))
  }
  return false
}

describe("IA registry", () => {
  const allItems = IA_GROUPS.flatMap((g) => g.items.map((i) => ({ ...i, group: g.id })))

  it("has the six groups in the agreed order", () => {
    expect(IA_GROUPS.map((g) => g.id)).toEqual(["market", "packs", "insights", "collectors", "trade", "me"])
  })

  it("inspected a real population (not-vacuous)", () => {
    expect(allItems.length).toBeGreaterThan(25)
  })

  it("every href — group hub and item — is a route that exists", () => {
    const missing = [...IA_GROUPS.map((g) => g.href), ...allItems.map((i) => i.href)].filter((h) => !routeExists(h))
    expect(missing).toEqual([])
  })

  it("every href shown to an anonymous visitor is public (never a 302 to /login)", () => {
    const anon = [
      ...IA_GROUPS.filter((g) => !g.auth).map((g) => resolveHref(g.href, DEFAULT_COLLECTION, g.page)),
      ...IA_GROUPS.flatMap((g) => visibleItems(g, false).map((i) => resolveHref(i.href, DEFAULT_COLLECTION, i.page))),
    ]
    const gated = anon.filter((h) => !isPublicPath(h.split("?")[0], "GET"))
    expect(gated).toEqual([])
  })

  it("no collection is a destination of its own (rule 5): no item label names a collection", () => {
    const names = publishedCollections().map((c) => c.shortLabel.toLowerCase())
    const offenders = allItems.filter((i) => names.includes(i.label.toLowerCase()))
    expect(offenders).toEqual([])
  })

  it("a collection-scoped href declares its page, so the fallback can be checked", () => {
    const bad = allItems.filter((i) => i.href.includes("{collection}") && !i.page)
    expect(bad).toEqual([])
  })

  it("resolveHref lands on the current collection when it has the page, else on the default", () => {
    expect(resolveHref("/{collection}/packs", "nfl-all-day", "packs")).toBe("/nfl-all-day/packs")
    // UFC has no packs page → default, never a soft-404
    expect(resolveHref("/{collection}/packs", "ufc", "packs")).toBe(`/${DEFAULT_COLLECTION}/packs`)
    expect(resolveHref("/{collection}/packs", "not-a-collection", "packs")).toBe(`/${DEFAULT_COLLECTION}/packs`)
    expect(resolveHref("/market", "ufc")).toBe("/market")
  })

  it("groupForPath names the owning group, and nothing for routes no group owns", () => {
    expect(groupForPath("/market")).toBe("market")
    expect(groupForPath("/nba-top-shot/sniper")).toBe("market") // a collection's sniper/market/hot-floors page is Market's
    expect(groupForPath("/nba-top-shot/market")).toBe("market")
    expect(groupForPath("/nba-top-shot/pack-sniper")).toBe("packs")
    expect(groupForPath("/nba-top-shot/badges")).toBeNull()
    expect(groupForPath("/sniper")).toBe("market")
    expect(groupForPath("/nfl-all-day/packs")).toBe("packs")
    expect(groupForPath("/trades/block")).toBe("trade")
    expect(groupForPath("/insights/rookies")).toBe("insights")
    expect(groupForPath("/insights/offer-spread")).toBe("market") // listed under Market first, by design
    expect(groupForPath("/dashboard")).toBe("me")
    expect(groupForPath("/")).toBeNull()
    expect(groupForPath("/marketing")).toBeNull() // prefix lookalike
  })

  it("the mobile bar shows a subset of the header's groups, in header order", () => {
    const order = IA_GROUPS.map((g) => g.id)
    const idx = MOBILE_GROUP_IDS.map((id) => order.indexOf(id))
    expect(idx.every((n) => n >= 0)).toBe(true)
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
  })
})
