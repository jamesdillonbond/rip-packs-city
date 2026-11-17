// lib/panini/product-url.ts — client-safe URL helpers for Panini product pages (no server imports).
//
// One page per Panini product NAME (several Panini set ids can share a name — drops/waves; migration
// 20261026013714). The slug is the slugified name, built by refresh_panini_product_rollup() with the SAME
// rule as paniniProductSlug below; an unnamed product is "Panini product <id>" → "panini-product-<id>".

/**
 * Mirrors the SQL: name_key = coalesce(nullif(btrim(name),''), 'Panini product ' || set_id);
 * slug = coalesce(nullif(btrim(regexp_replace(lower(name_key),'[^a-z0-9]+','-','g'),'-'),''), 'panini-product-' || id).
 * null when there is neither a usable name nor an id to fall back on.
 */
export function paniniProductSlug(name: string | null | undefined, setId?: number | null): string | null {
  const key = (name ?? "").trim() || (setId != null ? `Panini product ${setId}` : "")
  const tail = key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  if (tail) return tail
  return setId != null ? `panini-product-${setId}` : null
}

export function paniniProductHref(collectionUrlSlug: string, slug: string): string {
  return `/${collectionUrlSlug}/product/${encodeURIComponent(slug)}`
}

/** "#7/199" from a serial sku ("<psku>__7_199"); null when the sku carries none. */
export function serialLabelOfSku(sku: string): string | null {
  const m = /__(\d{1,6})_(\d{1,6})$/.exec(sku)
  return m ? `#${m[1]}/${m[2]}` : null
}
