import { describe, it, expect } from "vitest"
import {
  rootMetadata,
  entityUrl,
  collectionDisplayName,
  pageMetadata,
  collectionLayoutMetadata,
  collectionPageJsonLd,
  collectionPageMetadata,
  editionPageMetadata,
  setPageMetadata,
  playerPageMetadata,
  teamPageMetadata,
  seriesPageMetadata,
  breadcrumbJsonLd,
  editionJsonLd,
  playerJsonLd,
  teamJsonLd,
  collectionEntityJsonLd,
  packJsonLd,
  NOT_FOUND_METADATA,
} from "@/lib/seo"

// `Metadata.title` is `string | { absolute } | { default, template }`.
// collectionLayoutMetadata and the four entity builders returned bare strings
// until 2026-08-23 and now return the `absolute` form — deliberately, because
// restoring the collection subtree's `%s | Rip Packs City` template (R31) would
// otherwise have double-suffixed every one of them. These assertions pin the
// TITLE TEXT, which is unchanged; only its wrapper moved, so they are updated
// rather than deleted. `titleText` accepts both, so the helpers that still
// return a plain string (pageMetadata) are asserted by the same expression.
const titleText = (t: unknown): string =>
  t !== null && typeof t === "object" && "absolute" in (t as Record<string, unknown>)
    ? String((t as { absolute: unknown }).absolute)
    : String(t)


// SEO URL + display-name builders feed canonical <link>s, JSON-LD, and OG tags
// that crawlers index. A regression here poisons the search index or points
// canonicals at the wrong host, so pin the exact output shape.
//
// The blocks below the original two extend coverage over the metadata + JSON-LD
// builders: the {label} template substitution + canonical composition
// (pageMetadata / collectionLayoutMetadata / collectionPageMetadata), the
// entity-detail Metadata helpers (edition/set/player/team/series — title
// format, description-part assembly, USD/count formatting, TS series-map,
// franchise-vs-team vocab, OG-image vs default fallback), and the schema.org
// JSON-LD emitters (breadcrumb positions, Product offers with FMV/STALE/low-ask
// price selection, IPFS→proxy image rewrite, sku length cap, unknown-collection
// "Flow" fallback). Every pinned value was read from a real run, not guessed.

describe("entityUrl", () => {
  it("builds an absolute URL under the site origin", () => {
    expect(entityUrl("nba-top-shot", "player", "damian-lillard")).toBe(
      "https://www.rippackscity.com/nba-top-shot/player/damian-lillard"
    )
  })

  it("URL-encodes the slug segment (spaces, ampersands)", () => {
    expect(entityUrl("nfl-all-day", "team", "san francisco 49ers")).toBe(
      "https://www.rippackscity.com/nfl-all-day/team/san%20francisco%2049ers"
    )
    expect(entityUrl("nba-top-shot", "set", "run & gun")).toContain(
      "/set/run%20%26%20gun"
    )
  })
})

describe("collectionDisplayName", () => {
  it("maps known collection url-slugs to their display names", () => {
    expect(collectionDisplayName("nba-top-shot")).toBe("NBA Top Shot")
    expect(collectionDisplayName("nfl-all-day")).toBe("NFL All Day")
    expect(collectionDisplayName("laliga-golazos")).toBe("LaLiga Golazos")
    expect(collectionDisplayName("disney-pinnacle")).toBe("Disney Pinnacle")
    // The `ufc` url-slug maps to the "UFC Strike" brand name.
    expect(collectionDisplayName("ufc")).toBe("UFC Strike")
  })

  it("falls back to 'Flow' for unknown slugs", () => {
    expect(collectionDisplayName("not-a-collection")).toBe("Flow")
    expect(collectionDisplayName("")).toBe("Flow")
  })

  it("maps the legacy 'ufc-strike' URL alias to 'UFC Strike', not 'Flow'", () => {
    // getCollectionByUrlSlug accepts "ufc-strike", so /ufc-strike/... pages
    // render — without this alias key every label map fell through to "Flow",
    // branding a real UFC page as generic Flow in title/OG/breadcrumbs/JSON-LD.
    expect(collectionDisplayName("ufc-strike")).toBe("UFC Strike")
    // and it propagates through the entity-metadata + layout builders
    const em = editionPageMetadata({ route_slug: "x", player_name: "Fighter", set_name: "Set" }, "ufc-strike")
    expect(titleText(em.title)).toContain("UFC Strike")
    // Assert the BRAND SEGMENT specifically, not the bare substring "Flow".
    // The title legitimately names Flow as the closed VENUE ("... (Flow market
    // closed) | UFC Strike | ..."), because UFC Strike's Flow marketplace shut
    // on 2026-05-13 — see lib/market-closed.ts. What this test guards is the
    // alias falling through to the generic "Flow" BRAND label, which shows up
    // as the "| Flow |" segment.
    expect(titleText(em.title)).not.toContain("| Flow |")
    const lm = collectionLayoutMetadata("ufc-strike")
    expect(lm.keywords).toContain("UFC Strike")
  })
})

describe("pageMetadata", () => {
  it("substitutes {label} in title+description and builds the per-page canonical", () => {
    const m = pageMetadata("overview", "NBA Top Shot", "nba-top-shot")
    expect(titleText(m.title)).toBe("NBA Top Shot Value — FMV, Floor Prices & Market Pulse")
    expect(m.description).toContain("What NBA Top Shot moments are worth")
    expect((m.alternates as any).canonical).toBe(
      "https://www.rippackscity.com/nba-top-shot/overview"
    )
    // OG title gets the " | Rip Packs City" suffix; twitter title does not.
    expect((m.openGraph as any).title).toBe(
      "NBA Top Shot Value — FMV, Floor Prices & Market Pulse | Rip Packs City"
    )
    expect((m.openGraph as any).url).toBe(
      "https://www.rippackscity.com/nba-top-shot/overview"
    )
    expect((m.twitter as any).card).toBe("summary_large_image")
    expect((m.twitter as any).title).toBe(titleText(m.title))
  })

  it("returns an EMPTY object for an unknown page key (no meta template)", () => {
    expect(pageMetadata("not-a-page", "X", "y")).toEqual({})
  })

  it("replaces every {label} occurrence (global)", () => {
    const m = pageMetadata("sniper", "UFC Strike", "ufc")
    // sniper description ends with "…discount scoring for {label}." → the label
    // must not linger anywhere.
    expect(m.description).not.toContain("{label}")
    expect(m.description).toContain("discount scoring for UFC Strike.")
  })
})

describe("collectionLayoutMetadata", () => {
  it("uses the per-collection override + builds the OG collection image", () => {
    const m = collectionLayoutMetadata("nba-top-shot")
    expect(titleText(m.title)).toBe("NBA Top Shot Analytics — Rip Packs City")
    expect((m.alternates as any).canonical).toBe(
      "https://www.rippackscity.com/nba-top-shot"
    )
    expect((m.keywords as string[])[0]).toBe("NBA Top Shot")
    const og = (m.openGraph as any).images[0]
    expect(og.url).toBe(
      "https://www.rippackscity.com/api/og/collection?id=nba-top-shot"
    )
    expect(og.alt).toBe("NBA Top Shot")
    // ⚠ Asserted against the ROOT metadata's own handle rather than a literal.
    // This case previously pinned `@rippackscity` while rootMetadata used
    // `@RipPacksCity` — the only two places the handle appears, spelled
    // differently, with a test holding the inconsistency in place. X resolves
    // handles case-insensitively so neither was broken, which is exactly why it
    // survived. Comparing the two makes the property "they agree", so the next
    // divergence reds regardless of which spelling wins.
    expect((m.twitter as any).site).toBe((rootMetadata.twitter as any).creator)
  })

  it("falls back to the generic title + 'Flow' keyword for unknown collections", () => {
    const m = collectionLayoutMetadata("zzz")
    expect(titleText(m.title)).toBe("Rip Packs City — Collector Intelligence")
    expect((m.keywords as string[])[0]).toBe("Flow")
    expect((m.openGraph as any).images[0].alt).toBe("Flow")
    // The OG image id still echoes the raw (unknown) slug.
    expect((m.openGraph as any).images[0].url).toBe(
      "https://www.rippackscity.com/api/og/collection?id=zzz"
    )
  })
})

describe("collectionPageJsonLd", () => {
  it("emits a CollectionPage + BreadcrumbList graph for a known collection", () => {
    const ld = collectionPageJsonLd("ufc") as any
    expect(ld["@context"]).toBe("https://schema.org")
    const [page, crumb] = ld["@graph"]
    expect(page["@type"]).toBe("CollectionPage")
    expect(page["@id"]).toBe("https://www.rippackscity.com/ufc")
    expect(page.name).toBe("UFC Strike on Rip Packs City")
    // description sourced from COLLECTION_LAYOUT_META for known ids.
    expect(page.description).toContain("UFC Strike")
    expect(crumb["@type"]).toBe("BreadcrumbList")
    expect(crumb.itemListElement[1].name).toBe("UFC Strike")
    expect(crumb.itemListElement[1].position).toBe(2)
  })

  it("uses the raw id as name + generic description for an unknown collection", () => {
    const ld = collectionPageJsonLd("zzz") as any
    const [page] = ld["@graph"]
    expect(page.name).toBe("zzz on Rip Packs City")
    expect(page.description).toBe("Collector intelligence for zzz.")
  })
})

describe("collectionPageMetadata", () => {
  it("defaults the collection to nba-top-shot and resolves its label", () => {
    const m = collectionPageMetadata("sniper")
    expect(titleText(m.title)).toBe("Sniper — NBA Top Shot Deals Below FMV")
    expect((m.alternates as any).canonical).toBe(
      "https://www.rippackscity.com/nba-top-shot/sniper"
    )
  })

  it("falls back to the 'Flow' label for an unknown collection id", () => {
    const m = collectionPageMetadata("overview", "zzz")
    expect(titleText(m.title)).toBe("Flow Value — FMV, Floor Prices & Market Pulse")
    expect((m.alternates as any).canonical).toBe(
      "https://www.rippackscity.com/zzz/overview"
    )
  })
})

describe("editionPageMetadata", () => {
  it("composes the full FMV title/description with TS series-map + formatting", () => {
    const m = editionPageMetadata(
      {
        route_slug: "8:133",
        player_name: "Damian Lillard",
        set_name: "Base Set",
        tier: "COMMON",
        series_label: "7", // TS on-chain 7 → "Series 2024-25"
        circulation_count: 15000,
        fmv: { fmv_usd: 250.5 }, // >=100 → rounded, thousands-separated
      },
      "nba-top-shot"
    )
    expect(titleText(m.title)).toBe(
      "Damian Lillard — Base Set · Value $251 | NBA Top Shot | Rip Packs City"
    )
    expect(m.description).toBe(
      "Damian Lillard Base Set is worth ~$251 (FMV) on NBA Top Shot. Tier COMMON. Series 2024-25. Circulation 15,000. Live FMV, recent sales, history chart, and packs that contained this edition."
    )
    // encodeURIComponent turns the colon into %3A in the canonical + OG image.
    expect((m.alternates as any).canonical).toBe(
      "https://www.rippackscity.com/nba-top-shot/edition/8%3A133"
    )
    expect((m.openGraph as any).images[0].url).toBe(
      "https://www.rippackscity.com/api/og/edition?collection=nba-top-shot&slug=8%3A133"
    )
  })

  it("sub-$100 FMV uses 2-decimal formatting", () => {
    const m = editionPageMetadata(
      { route_slug: "a", fmv: { fmv_usd: 5.5 } },
      "nba-top-shot"
    )
    expect(titleText(m.title)).toBe(
      "Edition — Edition · Value $5.50 | NBA Top Shot | Rip Packs City"
    )
  })

  it("falls back to team_name when there is no player_name", () => {
    const m = editionPageMetadata(
      { team_name: "Lakers", set_name: "Team Set" },
      "nba-top-shot"
    )
    expect(titleText(m.title)).toBe(
      "Lakers — Team Set · Value, Floor & Sales | NBA Top Shot | Rip Packs City"
    )
  })

  it("empty payload + unknown collection → 'Edition'/'Flow' fallbacks + default OG", () => {
    const m = editionPageMetadata({}, "zzz")
    expect(titleText(m.title)).toBe(
      "Edition — Edition · Value, Floor & Sales | Flow | Rip Packs City"
    )
    // No route_slug → OG image falls back to /api/og/default (via buildMeta).
    expect((m.openGraph as any).images[0].url).toBe("/api/og/default")
  })
})

describe("setPageMetadata", () => {
  it("assembles the set title + count/circulation/FMV description parts", () => {
    const m = setPageMetadata(
      {
        set_name: "Metallic Gold LE",
        edition_count: 30,
        total_circulation: 5000,
        fmv_total_usd: 99999,
      },
      "nba-top-shot",
      "metallic gold le"
    )
    expect(titleText(m.title)).toBe(
      "Metallic Gold LE — Set Value & Editions | NBA Top Shot | Rip Packs City"
    )
    expect(m.description).toBe(
      "Metallic Gold LE on NBA Top Shot. 30 editions. 5,000 total circulation. Aggregate FMV $99,999. Tier mix, edition grid, and player breakdown."
    )
    // setSlug is encoded separately (spaces → %20).
    expect((m.alternates as any).canonical).toBe(
      "https://www.rippackscity.com/nba-top-shot/set/metallic%20gold%20le"
    )
  })

  it("empty payload drops the optional parts + uses default OG image", () => {
    const m = setPageMetadata({}, "zzz", "")
    expect(titleText(m.title)).toBe("Set — Set Value & Editions | Flow | Rip Packs City")
    expect(m.description).toBe(
      "Set on Flow. Tier mix, edition grid, and player breakdown."
    )
    expect((m.openGraph as any).images[0].url).toBe("/api/og/default")
  })
})

describe("playerPageMetadata", () => {
  it("player payload → 'Player' noun + 'Team:' label", () => {
    const m = playerPageMetadata(
      { name: "Damian Lillard", team: "Portland", edition_count: 42, fmv_total_usd: 12 },
      "nba-top-shot",
      "damian-lillard"
    )
    expect(m.description).toBe(
      "Damian Lillard (Player) on NBA Top Shot. Team: Portland. 42 editions. Portfolio FMV $12.00. Edition grid, top sale, and set breakdown."
    )
  })

  it("is_character payload flips noun→'Character' + label→'Franchise'", () => {
    const m = playerPageMetadata(
      { name: "Mickey", is_character: true, team: "Disney" },
      "disney-pinnacle",
      "mickey"
    )
    expect(m.description).toBe(
      "Mickey (Character) on Disney Pinnacle. Franchise: Disney. Edition grid, top sale, and set breakdown."
    )
  })
})

describe("teamPageMetadata", () => {
  it("team payload → lowercased 'team' noun + 'players' + roster copy", () => {
    const m = teamPageMetadata(
      { team_name: "Lakers", player_count: 5, edition_count: 10, fmv_total_usd: 500 },
      "nba-top-shot",
      "lakers"
    )
    expect(m.description).toBe(
      "Lakers team on NBA Top Shot. 5 players. 10 editions. Aggregate FMV $500. Roster grid and team breakdown."
    )
  })

  it("is_franchise payload → 'franchise' noun + 'characters' + cast copy", () => {
    const m = teamPageMetadata(
      { team_name: "Marvel", is_franchise: true, player_count: 3 },
      "disney-pinnacle",
      "marvel"
    )
    expect(m.description).toBe(
      "Marvel franchise on Disney Pinnacle. 3 characters. Cast grid and franchise breakdown."
    )
  })
})

describe("seriesPageMetadata", () => {
  it("adds the (Season …) title suffix + all optional description parts", () => {
    const m = seriesPageMetadata(
      {
        display_label: "Series 3",
        season: "2024",
        edition_count: 100,
        set_count: 5,
        player_count: 20,
        fmv_total_usd: 9,
      },
      "nba-top-shot",
      "series-3"
    )
    expect(titleText(m.title)).toBe(
      "Series 3 (Season 2024) — NBA Top Shot Editions & Values | Rip Packs City"
    )
    expect(m.description).toBe(
      "Series 3 on NBA Top Shot. Season 2024. 100 editions. 5 sets. 20 players. Aggregate FMV $9.00. Top editions, set breakdown, and player leaderboard."
    )
  })

  it("no season → title omits the parenthetical + uses default OG image", () => {
    const m = seriesPageMetadata({}, "zzz", "")
    expect(titleText(m.title)).toBe("Series — Flow Editions & Values | Rip Packs City")
    expect((m.openGraph as any).images[0].url).toBe("/api/og/default")
  })
})

describe("breadcrumbJsonLd", () => {
  it("numbers positions 1-based in input order", () => {
    const ld = breadcrumbJsonLd([
      { name: "Home", url: "h" },
      { name: "X", url: "u" },
    ]) as any
    expect(ld["@type"]).toBe("BreadcrumbList")
    expect(ld.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Home", item: "h" },
      { "@type": "ListItem", position: 2, name: "X", item: "u" },
    ])
  })
})

describe("editionJsonLd", () => {
  it("HIGH-confidence FMV → Product with FMV-priced Offer, IPFS image proxied, set crumb present", () => {
    const ld = editionJsonLd(
      {
        route_slug: "8:133",
        player_name: "Dame",
        set_name: "Base",
        set_slug: "base",
        tier: "COMMON",
        thumbnail_url: "https://ipfs.io/ipfs/QmAbc123",
        fmv: { fmv_usd: 100, confidence: "HIGH" },
      },
      "nba-top-shot"
    ) as any
    const [product, crumb] = ld["@graph"]
    expect(product["@type"]).toBe("Product")
    expect(product.name).toBe("Dame — Base")
    // ipfs.io CID rewritten to the same-origin edge proxy (absolute).
    expect(product.image).toBe(
      "https://www.rippackscity.com/api/public/ipfs-media/QmAbc123"
    )
    expect(product.sku).toBe("8:133") // short int-pair keeps its sku
    expect(product.category).toBe("COMMON")
    expect(product.offers.price).toBe(100)
    expect(product.offers.availability).toBe("https://schema.org/InStock")
    // With set_slug + set_name the breadcrumb has 4 items (Home/coll/set/edition).
    expect(crumb.itemListElement).toHaveLength(4)
    expect(crumb.itemListElement[2].name).toBe("Base")
  })

  it("STALE FMV is skipped as a price source; a live low ask still emits an Offer", () => {
    const ld = editionJsonLd(
      { route_slug: "8:133", fmv: { fmv_usd: 100, confidence: "STALE" } },
      "nba-top-shot",
      45
    ) as any
    const [product] = ld["@graph"]
    // Not the STALE 100 — the reliable low ask 45.
    expect(product.offers.price).toBe(45)
    // No thumbnail → image falls back to the OG edition route.
    expect(product.image).toBe(
      "https://www.rippackscity.com/api/og/edition?collection=nba-top-shot&slug=8%3A133"
    )
  })

  it("long descriptive slug (>40 chars) omits sku, and no price → no offers", () => {
    const ld = editionJsonLd(
      { route_slug: "a".repeat(50), name: "X" },
      "nfl-all-day"
    ) as any
    const [product] = ld["@graph"]
    expect(product.sku).toBeUndefined()
    expect(product.offers).toBeUndefined()
    expect(product.name).toBe("X — NFL All Day")
  })
})

describe("playerJsonLd", () => {
  it("emits Person with image + SportsTeam affiliation when present", () => {
    const ld = playerJsonLd(
      { name: "Dame", headshot_url: "h", team: "POR" },
      "nba-top-shot",
      "dame"
    ) as any
    const [person] = ld["@graph"]
    expect(person["@type"]).toBe("Person")
    expect(person.name).toBe("Dame")
    expect(person.image).toBe("h")
    expect(person.affiliation).toEqual({ "@type": "SportsTeam", name: "POR" })
  })
})

describe("teamJsonLd", () => {
  it("is_franchise → Organization, else SportsTeam", () => {
    const fran = teamJsonLd({ team_name: "Marvel", is_franchise: true }, "disney-pinnacle", "marvel") as any
    expect(fran["@graph"][0]["@type"]).toBe("Organization")
    const team = teamJsonLd({ team_name: "Lakers" }, "nba-top-shot", "lakers") as any
    expect(team["@graph"][0]["@type"]).toBe("SportsTeam")
    expect(team["@graph"][0].name).toBe("Lakers")
  })
})

describe("collectionEntityJsonLd", () => {
  it("builds a CollectionPage+ItemList, proxying IPFS thumbs and capping labels", () => {
    const ld = collectionEntityJsonLd({
      name: "Set X",
      url: "https://u",
      collectionUrlSlug: "nba-top-shot",
      eds: [
        { route_slug: "1:1", player_name: "A", thumbnail_url: "https://ipfs.io/ipfs/QmX" },
      ],
      crumbName: "Set X",
    }) as any
    const [page] = ld["@graph"]
    expect(page.mainEntity.numberOfItems).toBe(1)
    const li = page.mainEntity.itemListElement[0]
    expect(li.url).toBe("https://www.rippackscity.com/nba-top-shot/edition/1%3A1")
    expect(li.name).toBe("A")
    expect(li.image).toBe("https://www.rippackscity.com/api/public/ipfs-media/QmX")
  })

  it("caps the ItemList at 25 editions", () => {
    const eds = Array.from({ length: 40 }, (_, i) => ({ route_slug: `${i}:0`, name: `E${i}` }))
    const ld = collectionEntityJsonLd({
      name: "Big Set",
      url: "https://u",
      collectionUrlSlug: "nba-top-shot",
      eds,
      crumbName: "Big Set",
    }) as any
    expect(ld["@graph"][0].mainEntity.numberOfItems).toBe(25)
  })
})

describe("packJsonLd", () => {
  it("retail price → Offer; explicit image wins over OG fallback", () => {
    const ld = packJsonLd({
      title: "Pack A",
      collectionUrlSlug: "nba-top-shot",
      distId: "d1",
      retailPriceUsd: 9.99,
    }) as any
    const [product] = ld["@graph"]
    expect(product.offers.price).toBe(9.99)
    // No explicit image → OG pack route.
    expect(product.image).toBe(
      "https://www.rippackscity.com/api/og/pack?collection=nba-top-shot&distId=d1"
    )
  })

  it("no retail price + unknown collection → no offers, 'Flow' brand, explicit image kept", () => {
    const ld = packJsonLd({
      title: "Pack B",
      image: "http://img",
      collectionUrlSlug: "zzz",
      distId: "d2",
    }) as any
    const [product] = ld["@graph"]
    expect(product.offers).toBeUndefined()
    expect(product.brand.name).toBe("Flow")
    expect(product.image).toBe("http://img")
  })
})

describe("NOT_FOUND_METADATA", () => {
  it("marks the page noindex/nofollow so soft-404s stay out of the index", () => {
    expect(NOT_FOUND_METADATA.title).toBe("Not Found")
    expect((NOT_FOUND_METADATA.robots as any)).toEqual({ index: false, follow: false })
  })
})

describe("prototype-key collection slugs never surface a prototype member", () => {
  // Every collection lookup map in seo.ts is keyed by the unvalidated
  // [collection] route segment. A bare MAP[key] read would resolve
  // "constructor"/"toString"/etc. to an Object.prototype function, defeating
  // the "?? Flow" fallback and putting a function into a <title>/meta/JSON-LD.
  const PROTO_KEYS = ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"]

  for (const key of PROTO_KEYS) {
    it(`collectionDisplayName("${key}") returns the Flow fallback string`, () => {
      const out = collectionDisplayName(key)
      expect(typeof out).toBe("string")
      expect(out).toBe("Flow")
    })

    it(`collectionLayoutMetadata("${key}") returns the generic fallback, not a prototype member`, () => {
      const meta = collectionLayoutMetadata(key)
      // The shape matters as much as the text: a prototype member surfacing
      // here would arrive as a string, so the deliberate object form is
      // asserted alongside the value.
      expect(typeof meta.title).toBe("object")
      expect(titleText(meta.title)).toBe("Rip Packs City — Collector Intelligence")
    })

    it(`collectionPageJsonLd("${key}") yields a string name/description (no thrown/fn)`, () => {
      const ld = collectionPageJsonLd(key) as any
      const node = ld["@graph"][0]
      expect(typeof node.name).toBe("string")
      expect(node.name).toBe(`${key} on Rip Packs City`)
      expect(typeof node.description).toBe("string")
    })
  }
})
