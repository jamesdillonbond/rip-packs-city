// lib/league-map.ts
//
// The COVERAGE MAP (/leagues, 2026-11-26): every league and brand RPC tracks, and where its cards live.
// A league is one tile no matter how many publishers cover it — NBA is NBA Top Shot AND Panini; WWE is
// Panini AND Candy. Pure: the page passes the two publisher boards in (null = that read failed), so a
// failed read is NAMED on the page and never rendered as "this publisher covers nothing".
// ⛔ The level's code word ("property") never renders: on screen it is "Leagues" and "Entertainment".

export type LeagueMapHeading = "leagues" | "entertainment"

export interface LeagueMapSource {
  /** "NBA Top Shot", "Panini", "Candy" — what the collector calls the place the cards live. */
  label: string
  href: string
  /** "12 products · 9,010 cards"; null when there is nothing counted to say. */
  detail: string | null
}

export interface LeagueMapEntry {
  key: string
  name: string
  heading: LeagueMapHeading
  category: string
  /** Team hubs exist for this league (/teams). */
  teamHubs: boolean
  sources: LeagueMapSource[]
  order: number
}

export interface PublisherTile {
  slug: string
  name: string
  heading: LeagueMapHeading
  category: string
  team_league: string | null
  sort_order: number
}
export interface PaniniTile extends PublisherTile { products: number; editions: number }
export interface CandyTile extends PublisherTile { collections: number; cards: number }

const n = (v: number) => v.toLocaleString("en-US")
const plural = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`

/** Collections that ARE a league or brand of their own. `key` is the tile a publisher's same-named row joins. */
const DEDICATED: { key: string; name: string; heading: LeagueMapHeading; category: string; teamHubs: boolean; order: number; label: string; href: string; detail: string | null }[] = [
  { key: "nba", name: "NBA", heading: "leagues", category: "Basketball", teamHubs: true, order: 10, label: "NBA Top Shot", href: "/nba-top-shot/overview", detail: "Moments" },
  { key: "wnba", name: "WNBA", heading: "leagues", category: "Basketball", teamHubs: true, order: 20, label: "NBA Top Shot", href: "/nba-top-shot/overview", detail: "WNBA Moments live inside Top Shot" },
  { key: "nfl", name: "NFL", heading: "leagues", category: "Football", teamHubs: true, order: 30, label: "NFL All Day", href: "/nfl-all-day/overview", detail: "Moments" },
  { key: "laliga", name: "LaLiga", heading: "leagues", category: "Soccer", teamHubs: true, order: 50, label: "LaLiga Golazos", href: "/laliga-golazos/overview", detail: "Moments" },
  { key: "ufc", name: "UFC", heading: "leagues", category: "Mixed martial arts", teamHubs: false, order: 60, label: "UFC Strike", href: "/ufc/overview", detail: "Moments" },
  { key: "disney", name: "Disney, Pixar and Star Wars", heading: "entertainment", category: "Film and TV", teamHubs: false, order: 200, label: "Disney Pinnacle", href: "/disney-pinnacle/overview", detail: "Pins" },
]

/** Publisher-only leagues that belong among the big leagues rather than after them. */
const ORDER_HINT: Record<string, number> = { mlb: 40, "fifa-world-cup": 45 }

export function buildLeagueMap(input: { panini: PaniniTile[] | null; candy: CandyTile[] | null }): {
  leagues: LeagueMapEntry[]
  entertainment: LeagueMapEntry[]
  /** Publishers whose list could not be read — named on the page, never shown as "covers nothing". */
  failed: string[]
} {
  const by = new Map<string, LeagueMapEntry>()
  for (const d of DEDICATED) {
    by.set(d.key, { key: d.key, name: d.name, heading: d.heading, category: d.category, teamHubs: d.teamHubs, order: d.order, sources: [{ label: d.label, href: d.href, detail: d.detail }] })
  }
  const add = (t: PublisherTile, base: number, source: LeagueMapSource) => {
    const hit = by.get(t.slug)
    if (hit) {
      hit.sources.push(source)
      if (t.team_league) hit.teamHubs = true
      return
    }
    by.set(t.slug, {
      key: t.slug,
      name: t.name,
      heading: t.heading,
      category: t.category,
      teamHubs: !!t.team_league,
      order: ORDER_HINT[t.slug] ?? base + t.sort_order,
      sources: [source],
    })
  }
  for (const t of input.panini ?? []) {
    if (t.products <= 0) continue
    add(t, 100, { label: "Panini", href: `/panini-blockchain/property/${encodeURIComponent(t.slug)}`, detail: `${plural(t.products, "product", "products")} · ${plural(t.editions, "card", "cards")}` })
  }
  for (const t of input.candy ?? []) {
    if (t.collections <= 0) continue
    add(t, 100, { label: "Candy", href: `/candy-mlb/property/${encodeURIComponent(t.slug)}`, detail: `${plural(t.collections, "collection", "collections")} · ${plural(t.cards, "card", "cards")}` })
  }
  const all = [...by.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  const failed: string[] = []
  if (input.panini === null) failed.push("Panini")
  if (input.candy === null) failed.push("Candy")
  return { leagues: all.filter((e) => e.heading === "leagues"), entertainment: all.filter((e) => e.heading === "entertainment"), failed }
}
