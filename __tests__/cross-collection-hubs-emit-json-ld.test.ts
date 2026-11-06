import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { playerHubJsonLd, franchiseHubJsonLd } from "@/lib/seo"

// The cross-collection hubs (/players/<slug>, /teams/<league>/<slug>) went
// index,follow on 2026-10-22 and into the sitemap on 10-23 (~2,000 + 31 URLs),
// but carried NO structured data while every per-collection player/team page
// carries Person/SportsTeam + BreadcrumbList (found by a live curl 2026-11-06).
// These pin the two builders and that both pages actually mount them.

const SITE = "https://www.rippackscity.com"

describe("playerHubJsonLd", () => {
  it("emits Person + BreadcrumbList for a single-person hub, with an absolute image", () => {
    const ld = playerHubJsonLd({ name: "Jamal Murray", path: "/players/jamal-murray", image: "/api/public/ipfs-media/x", manyPeople: false }) as any
    expect(ld["@context"]).toBe("https://schema.org")
    const [person, crumbs] = ld["@graph"]
    expect(person["@type"]).toBe("Person")
    expect(person.url).toBe(`${SITE}/players/jamal-murray`)
    expect(person.image).toBe(`${SITE}/api/public/ipfs-media/x`)
    expect(crumbs["@type"]).toBe("BreadcrumbList")
    expect(crumbs.itemListElement.map((i: any) => i.name)).toEqual(["Home", "Jamal Murray"])
  })

  it("a name that spans sports is NOT one Person — breadcrumb only (rule 2)", () => {
    const ld = playerHubJsonLd({ name: "Josh Allen", path: "/players/josh-allen", manyPeople: true }) as any
    expect(ld["@graph"].map((n: any) => n["@type"])).toEqual(["BreadcrumbList"])
  })

  it("omits image when the hub has none", () => {
    const ld = playerHubJsonLd({ name: "X", path: "/players/x", image: null, manyPeople: false }) as any
    expect("image" in ld["@graph"][0]).toBe(false)
  })
})

describe("franchiseHubJsonLd", () => {
  it("emits SportsTeam + BreadcrumbList", () => {
    const ld = franchiseHubJsonLd({ name: "Portland Trail Blazers", path: "/teams/nba/portland-trail-blazers", league: "nba" }) as any
    const [team, crumbs] = ld["@graph"]
    expect(team["@type"]).toBe("SportsTeam")
    expect(team.sport).toBe("NBA")
    expect(team["@id"]).toBe(`${SITE}/teams/nba/portland-trail-blazers`)
    expect(crumbs.itemListElement[1].item).toBe(`${SITE}/teams/nba/portland-trail-blazers`)
  })
})

describe("both hub pages mount the script", () => {
  it("player hub", () => {
    const src = readFileSync("app/players/[slug]/page.tsx", "utf8")
    expect(src).toMatch(/jsonLdScript\(playerHubJsonLd\(/)
    expect(src).toContain('type="application/ld+json"')
  })
  it("franchise hub", () => {
    const src = readFileSync("app/teams/[league]/[slug]/page.tsx", "utf8")
    expect(src).toMatch(/jsonLdScript\(franchiseHubJsonLd\(/)
    expect(src).toContain('type="application/ld+json"')
  })
})
