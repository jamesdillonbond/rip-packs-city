// Top Shot's Studio Platform GraphQL sometimes surfaces a pack distribution's
// retail price in 10⁸-denominated "wei" units (e.g. 900000000 for $9) and
// other times as plain dollars. The same field flows into
// pack_distributions.metadata.retail_price_usd, so any reader needs to
// disambiguate. The threshold works because no real Top Shot pack retails at
// anywhere near $1M, and no wei-denominated value lands below $100k.
export function normalizePackRetailPrice(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw ?? 0)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n >= 1_000_000 ? n / 1e8 : n
}
