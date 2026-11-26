// lib/candy/collections-progress.ts
//
// A wallet's progress across EVERY Candy collection it holds a card of (2026-11-26) — the Candy Sets tab
// beyond the 2026 MLB Base Series tracker. Client-safe: the parse and the brand options.
// Data: /api/candy-collections-progress (candy_wallet_collection_progress, migration 20261126231408).

export interface CandyCollectionProgress {
  name: string
  /** null when the name yields no page slug. */
  set_slug: string | null
  /** League / brand slug and name; null when the collection is not placed under one. */
  brand: string | null
  brand_name: string | null
  line: string | null
  /** Different cards RPC has catalogued for the collection — a floor on its checklist. */
  editions: number
  owned_editions: number
  cards: number
}

export interface CandyCollectionsProgress {
  /** Candy collections RPC tracks in all — the list below is only those the wallet holds a card of. */
  collections_total: number
  collections: CandyCollectionProgress[]
}

/** Pure parse; null = not the expected shape (a failed read). */
export function toCandyCollectionsProgress(json: unknown): CandyCollectionsProgress | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null
  const d = json as Record<string, unknown>
  if (!Array.isArray(d.collections)) return null
  const total = Number(d.collections_total)
  if (!Number.isFinite(total)) return null
  const str = (v: unknown) => (typeof v === "string" && v ? v : null)
  const collections: CandyCollectionProgress[] = []
  for (const r of d.collections as Array<Record<string, unknown>>) {
    const name = str(r?.name)
    const editions = Number(r?.editions)
    const owned = Number(r?.owned_editions)
    if (!name || !Number.isFinite(editions) || editions <= 0 || !Number.isFinite(owned)) continue
    const cards = Number(r?.cards)
    collections.push({ name, set_slug: str(r.set_slug), brand: str(r.brand), brand_name: str(r.brand_name), line: str(r.line), editions, owned_editions: Math.min(owned, editions), cards: Number.isFinite(cards) ? cards : 0 })
  }
  return { collections_total: total, collections }
}

/** Brands present in the list, most collections first. */
export function progressBrandOptions(rows: readonly CandyCollectionProgress[]): { slug: string; name: string; collections: number }[] {
  const by = new Map<string, { slug: string; name: string; collections: number }>()
  for (const r of rows) {
    if (!r.brand || !r.brand_name) continue
    const hit = by.get(r.brand)
    if (hit) hit.collections += 1
    else by.set(r.brand, { slug: r.brand, name: r.brand_name, collections: 1 })
  }
  return [...by.values()].sort((a, b) => b.collections - a.collections || a.name.localeCompare(b.name))
}
