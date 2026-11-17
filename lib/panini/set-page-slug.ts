// lib/panini/set-page-slug.ts
//
// The set-page slug of one Panini PRODUCT's set (2026-10-21, #204), built the way the products
// bridge builds the `sets.external_id` the page resolves (migration 20261004190100):
//   product 2332 (the 2026 World Cup catalog): 'panini-'            || btrim(slug(set_name), '-')
//   every other product:                       'panini-p<product>-' || btrim(slug(set_name), '-')
// minus the 'panini-' prefix. Client-safe (no DB).
//
// ⚠ A set name ONE product carries has its page at the NAME slug, and this key answers 308 there —
// correct, one hop. Only the server (get_set_detail.canonical_slug) knows which names are shared.

import { PANINI_WC_SET_ID } from "@/lib/panini/set-progress"

export function paniniProductSetSlug(productSetId: number | null | undefined, setName: string | null | undefined): string | null {
  if (typeof productSetId !== "number" || !Number.isInteger(productSetId) || productSetId <= 0) return null
  const name = typeof setName === "string" ? setName.trim() : ""
  if (!name) return null
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  if (!key) return null
  return productSetId === PANINI_WC_SET_ID ? key : `p${productSetId}-${key}`
}
