import type { APIRequestContext } from "playwright/test"

// Live entity-URL discovery for the rendered-DOM monitor.
//
// The entity/detail pages (/edition, /moment, /set, /player, /team, /series,
// /pack) are the highest-traffic, slug-keyed pages — and the ones behind the
// pooler-saturation Sentry incidents — yet smoke.spec.ts probes none of them,
// because their URLs are DATA-dependent (a hardcoded slug rots the day that
// entity churns). The sitemap is the app's own canonical, SEO-durable list of
// currently-valid entity URLs (segment children /sitemap/<id>.xml, already anon
// per proxy.ts), so we discover a real, live URL per entity type from it at run
// time. Fail-soft: a type with no discovered URL is skipped, never failed — a
// thin catalog segment must not red the monitor.

/** Pure: extract every <loc> value from a sitemap/​sitemapindex XML string. */
export function parseSitemapLocs(xml: string): string[] {
  const out: string[] = []
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    out.push(m[1])
  }
  return out
}

/** Pure: reduce an absolute URL to its path (+search) so it resolves against
 * the test's baseURL rather than whatever origin the sitemap was built with. */
export function toPath(loc: string): string {
  try {
    const u = new URL(loc)
    return u.pathname + u.search
  } catch {
    return loc
  }
}

/** Pure: first URL whose path matches the entity segment, as a baseURL-relative
 * path — or null when the segment isn't present in this batch of locs. */
export function pickEntityPath(locs: string[], segment: RegExp): string | null {
  const hit = locs.map(toPath).find((p) => segment.test(p))
  return hit ?? null
}

// Which sitemap segment carries each entity type, and the path marker that
// identifies it. Mirrors app/sitemap.xml/route.ts's segment map:
//   0 static+insights+overviews+series+profiles · 1 TopShot editions
//   2 AllDay/Golazos/UFC editions · 3 entities(set/player/team)+top-moments
//   4 packs+Pinnacle pins
export const ENTITY_SPEC: Record<string, { sitemap: number; segment: RegExp }> = {
  edition: { sitemap: 1, segment: /\/edition\// },
  // ⚠ `edition` above resolves from segment 1, which is TOP SHOT ONLY (see
  // buildSitemapSegment in lib/sitemap-data.ts — segment 1 is TS, segment 2 is
  // AllDay/Golazos/UFC). So the edition probe was structurally blind to THREE
  // collections' edition pages by construction, not by chance: a non-TS edition
  // page could 500 or render a blank shell indefinitely and this monitor would
  // stay green. Golazos is named explicitly rather than "first URL in segment
  // 2" because that segment is dominated by AllDay's 6,190 editions, so an
  // unnamed pick would almost never land on the other two.
  edition_golazos: { sitemap: 2, segment: /\/laliga-golazos\/edition\// },
  moment: { sitemap: 3, segment: /^\/moment\// },
  set: { sitemap: 3, segment: /\/set\// },
  player: { sitemap: 3, segment: /\/player\// },
  team: { sitemap: 3, segment: /\/team\// },
  series: { sitemap: 0, segment: /\/series\// },
  pack: { sitemap: 4, segment: /\/pack\// },
}

export type EntityType = keyof typeof ENTITY_SPEC

const cache = new Map<number, string[]>()

/** Fetch + memoize the <loc> list for a sitemap segment. Returns [] on any
 * non-200 or fetch error so callers degrade to a skip rather than a hard fail. */
export async function fetchSitemapLocs(request: APIRequestContext, id: number): Promise<string[]> {
  if (cache.has(id)) return cache.get(id)!
  let locs: string[] = []
  try {
    const res = await request.get(`/sitemap/${id}.xml`, { timeout: 20_000 })
    if (res.ok()) locs = parseSitemapLocs(await res.text())
  } catch {
    locs = []
  }
  cache.set(id, locs)
  return locs
}

/** Discover a live, baseURL-relative URL for one entity type, or null. */
export async function discoverEntityPath(
  request: APIRequestContext,
  type: EntityType,
): Promise<string | null> {
  const spec = ENTITY_SPEC[type]
  const locs = await fetchSitemapLocs(request, spec.sitemap)
  return pickEntityPath(locs, spec.segment)
}
