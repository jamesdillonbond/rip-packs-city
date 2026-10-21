// __tests__/collection-json-ld-is-overview-only.test.ts
//
// 2026-10-21 SEO pass. Every page under /[collection]/* emitted TWO
// BreadcrumbLists: the [collection] layout's 2-rung "Home → NBA Top Shot
// (/overview)" plus the page's own 4-rung "Home → NBA Top Shot (/nba-top-shot) →
// Signature Series → Kon Knueppel" — two conflicting trails, and the second
// one's collection rung named /nba-top-shot, which 307s to /overview. Pins:
//   1. the [collection] layout emits no JSON-LD; overview/layout.tsx does;
//   2. every entity trail's collection rung is the 200 URL (/overview).

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { editionJsonLd, playerJsonLd, teamJsonLd, collectionCrumbUrl } from "@/lib/seo"

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8")

type Node = Record<string, unknown>
const crumbs = (ld: unknown): string[] => {
  const graph = ((ld as { "@graph"?: Node[] })["@graph"] ?? []) as Node[]
  const list = graph.find((n) => n["@type"] === "BreadcrumbList") as { itemListElement: { item: string }[] } | undefined
  if (!list) throw new Error("no BreadcrumbList")
  return list.itemListElement.map((x) => x.item)
}

describe("the collection JSON-LD lives on the overview only", () => {
  it("the [collection] layout emits no ld+json script", () => {
    expect(stripComments(read("app/(collections)/[collection]/layout.tsx"))).not.toContain("application/ld+json")
  })

  it("the overview layout emits the collection CollectionPage + breadcrumb", () => {
    const src = stripComments(read("app/(collections)/[collection]/overview/layout.tsx"))
    expect(src).toContain("application/ld+json")
    expect(src).toContain("collectionPageJsonLd(")
  })

  it("entity trails name the collection by its 200 URL (/overview), never the 307 /<collection>", () => {
    expect(collectionCrumbUrl("nba-top-shot")).toBe("https://www.rippackscity.com/nba-top-shot/overview")
    const ed = editionJsonLd({ route_slug: "260:8820", player_name: "Kon Knueppel", set_name: "Signature Series" }, "nba-top-shot")
    const pl = playerJsonLd({ player_name: "Kon Knueppel" }, "nba-top-shot", "kon-knueppel")
    const tm = teamJsonLd({ team_name: "Portland Trail Blazers" }, "nba-top-shot", "portland-trail-blazers")
    for (const ld of [ed, pl, tm]) {
      const items = crumbs(ld)
      expect(items[1]).toBe("https://www.rippackscity.com/nba-top-shot/overview")
      expect(items).not.toContain("https://www.rippackscity.com/nba-top-shot")
    }
  })

  it("no lib/seo.ts trail builds the bare collection URL", () => {
    const src = stripComments(read("lib/seo.ts"))
    expect(src).not.toMatch(/name: label, url: `\$\{BASE_URL\}\/\$\{(opts\.)?collectionUrlSlug\}`/)
  })
})
