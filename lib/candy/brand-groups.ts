// lib/candy/brand-groups.ts
//
// Group Candy sets by league / brand (2026-11-26). Client-safe: types and a pure grouping — the reads live in
// lib/candy/properties.ts (service role). A null index (the read failed) yields ONE unnamed group, so the
// caller shows its list as before rather than a guessed brand.

export interface CandySetBrandIndex {
  /** sets.id → brand slug. */
  bySetId: Record<string, string>
  /** Brand slug → display name, in display order (`order`). */
  names: Record<string, string>
  order: string[]
}


/** Rows grouped by brand in display order; rows with no brand come last under `null`. One group when `index` is null. */
export function groupByCandyBrand<T>(rows: readonly T[], setIdOf: (row: T) => string, index: CandySetBrandIndex | null): { slug: string | null; name: string | null; rows: T[] }[] {
  if (!index) return [{ slug: null, name: null, rows: [...rows] }]
  const by = new Map<string, T[]>()
  const rest: T[] = []
  for (const r of rows) {
    const slug = index.bySetId[setIdOf(r)]
    if (!slug) { rest.push(r); continue }
    const list = by.get(slug)
    if (list) list.push(r)
    else by.set(slug, [r])
  }
  const out: { slug: string | null; name: string | null; rows: T[] }[] = index.order.filter((s) => by.has(s)).map((s) => ({ slug: s, name: index.names[s], rows: by.get(s)! }))
  if (rest.length > 0) out.push({ slug: null, name: null, rows: rest })
  return out
}
