// Pure view-shaping for the player/character entity page
// (app/(collections)/[collection]/player/[slug]/page.tsx).
//
// Extracted verbatim from the server page (which NEITHER coverage gate measures)
// so the group-by-set aggregation is measured + unit-tested. buildPlayerSetCards
// groups a player's editions into per-set summary cards (moment count + summed
// FMV) ordered by FMV desc — the "Sets featuring X" strip. A regression here
// mis-sums a collector's per-set value or drops a set on a heavily-trafficked,
// pooler-sensitive entity page. Structural input type so the lib stays decoupled
// from the EditionTile component type (EditionTile[] is assignable to it).

export interface PlayerEditionForSets {
  set_slug?: string | null
  set_name?: string | null
  fmv_usd?: number | null
}

export interface PlayerSetCard {
  setSlug: string
  setName: string
  count: number
  fmvTotal: number
}

export function buildPlayerSetCards(editions: readonly PlayerEditionForSets[]): PlayerSetCard[] {
  const setMap = new Map<string, PlayerSetCard>()
  for (const e of editions) {
    if (!e.set_slug || !e.set_name) continue
    const existing = setMap.get(e.set_slug)
    if (existing) {
      existing.count += 1
      existing.fmvTotal += e.fmv_usd ?? 0
    } else {
      setMap.set(e.set_slug, { setSlug: e.set_slug, setName: e.set_name, count: 1, fmvTotal: e.fmv_usd ?? 0 })
    }
  }
  return Array.from(setMap.values()).sort((a, b) => b.fmvTotal - a.fmvTotal)
}
