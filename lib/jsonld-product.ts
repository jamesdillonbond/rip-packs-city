// lib/jsonld-product.ts
//
// A schema.org `Product` with no `offers`, `review` or `aggregateRating` is an
// INVALID Product snippet to Google ("Either "offers", "review", or
// "aggregateRating" should be specified"). It earns no rich result and is
// reported as an error in Search Console.
//
// ── THE CASE (2026-10-20, Search Console → Shopping → Product snippets) ────
// 5 invalid items, all Panini edition pages with no usable FMV and no fresh
// ask, so `editionJsonLd` correctly withheld the Offer — and still typed the
// node `Product`. The same shape exists by construction on every closed-market
// edition (UFC emits NO Offer on purpose), every pack with no retail price and
// every Pinnacle pin with no FMV.
//
// ⛔ We must NOT fabricate a price, review or rating to make it valid (rule 1:
// read-only, and no fake aggregateRating — see editionJsonLd). So when there is
// no Offer the honest node is a `CreativeWork`: it carries the same name,
// description, image and url, makes no commerce claim, and has no required
// fields to fail. Product-only properties (brand, sku, category) are dropped so
// the node validates as what it claims to be.
//
// ⓘ JSON-LD type does not govern indexing — the page stays `index, follow`
// either way. An invalid Product earned nothing; a CreativeWork loses nothing.

const PRODUCT_ONLY_KEYS = ["brand", "sku", "category", "offers"] as const

export function productOrCreativeWork<T extends Record<string, unknown>>(node: T): T {
  if (node["@type"] !== "Product") return node
  if (node.offers != null || node.review != null || node.aggregateRating != null) return node
  const out: Record<string, unknown> = { ...node, "@type": "CreativeWork" }
  for (const k of PRODUCT_ONLY_KEYS) delete out[k]
  return out as T
}
