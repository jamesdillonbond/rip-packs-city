// Panini product names from collectors' own collections (2026-10-04).
//
// panini_products is keyed by Panini's card set id (the "<setId>" in "packcard-<setId>_…"), but nothing
// the card walk reads carries the product's NAME — 135 of 137 products were unnamed, and naming needed
// a signed-in Chrome by hand (status page, step 2). The collector walk reads a profile ONE COLLECTION
// AT A TIME (collectionList -> each collection's card pages), and a collection is a product: its cname
// is Panini's product name ("2026 Panini NFT Prizm WNBA"). So every card it reads inside a collection
// is a (set id, name) observation. The walk tallies them and posts the tally; this decides.
//
// A name is taken only when the evidence is unambiguous: at least MIN_CARDS cards, and the top name
// holds at least MIN_SHARE of that set id's cards (a card listed under the wrong collection, or a
// collection spanning two set ids, must not name a product). The route fills a NULL name only — a
// name already set (by hand or earlier) is never overwritten.

export type ProductNameObservation = { set_id: number; name: string; n: number }
export type ProductNameDecision = { set_id: number; name: string; n: number; share: number }

export const MIN_CARDS = 3
export const MIN_SHARE = 0.8

/** Parse the posted tally; malformed rows are dropped, never half-read. */
export function parseProductNameObservations(v: unknown): ProductNameObservation[] {
  if (!Array.isArray(v)) return []
  const out: ProductNameObservation[] = []
  for (const r of v.slice(0, 5000)) {
    if (!r || typeof r !== "object") continue
    const o = r as Record<string, unknown>
    const sid = Number(o.set_id)
    const n = Number(o.n)
    const name = typeof o.name === "string" ? o.name.trim() : ""
    if (!Number.isInteger(sid) || sid <= 0 || !Number.isInteger(n) || n <= 0 || !name || name.length > 200) continue
    out.push({ set_id: sid, name, n })
  }
  return out
}

/** One decision per set id whose top name is unambiguous; everything else is left unnamed. */
export function decideProductNames(obs: ProductNameObservation[]): { named: ProductNameDecision[]; ambiguous: number[] } {
  const bySet = new Map<number, Map<string, number>>()
  for (const o of obs) {
    const m = bySet.get(o.set_id) ?? new Map<string, number>()
    m.set(o.name, (m.get(o.name) ?? 0) + o.n)
    bySet.set(o.set_id, m)
  }
  const named: ProductNameDecision[] = []
  const ambiguous: number[] = []
  for (const [sid, names] of bySet) {
    let total = 0
    let top = ""
    let topN = 0
    for (const [name, n] of names) {
      total += n
      if (n > topN || (n === topN && name < top)) { top = name; topN = n }
    }
    const share = topN / total
    if (topN >= MIN_CARDS && share >= MIN_SHARE) named.push({ set_id: sid, name: top, n: topN, share: Math.round(share * 1000) / 1000 })
    else ambiguous.push(sid)
  }
  named.sort((a, b) => a.set_id - b.set_id)
  ambiguous.sort((a, b) => a - b)
  return { named, ambiguous }
}
