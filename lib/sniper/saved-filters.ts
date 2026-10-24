// lib/sniper/saved-filters.ts — the Sniper remembers a reader's filters on this
// device (2026-10-24).
//
// The one new collector who retained over 10-10 → 10-24 (shashmeister) applied
// ~3,100 Sniper filters in four days — re-building the same board on every visit,
// because filters lived only in the URL and only after COPY LINK. Filters are now
// kept per collection in localStorage and restored when the page opens WITHOUT
// filters in its URL (a shared link always wins). Per device by design: no
// account needed, nothing sent anywhere.

export type SavedSniperFilters = {
  tier?: string
  sort?: string
  minDiscount?: number
  maxPrice?: number
  team?: string
  player?: string
}

const key = (slug: string) => `rpc_sniper_filters:${slug}`

export function loadSniperFilters(slug: string): SavedSniperFilters | null {
  try {
    const raw = window.localStorage.getItem(key(slug))
    if (!raw) return null
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== "object") return null
    const o = v as Record<string, unknown>
    const out: SavedSniperFilters = {}
    if (typeof o.tier === "string") out.tier = o.tier
    if (typeof o.sort === "string") out.sort = o.sort
    if (typeof o.minDiscount === "number" && Number.isFinite(o.minDiscount)) out.minDiscount = o.minDiscount
    if (typeof o.maxPrice === "number" && Number.isFinite(o.maxPrice)) out.maxPrice = o.maxPrice
    if (typeof o.team === "string") out.team = o.team
    if (typeof o.player === "string") out.player = o.player.slice(0, 80)
    return out
  } catch {
    return null
  }
}

export function saveSniperFilters(slug: string, f: SavedSniperFilters): void {
  try {
    window.localStorage.setItem(key(slug), JSON.stringify(f))
  } catch {
    /* private mode / storage blocked: the board still works, it just forgets */
  }
}

/** True when the URL already carries a filter — a shared link is never overridden. */
export function urlHasSniperFilters(u: { tier?: unknown; sort?: unknown; minDiscount?: unknown; maxPrice?: unknown; team?: unknown; player?: unknown }): boolean {
  return [u.tier, u.sort, u.minDiscount, u.maxPrice, u.team, u.player].some((v) => v !== undefined && v !== null && v !== "")
}
