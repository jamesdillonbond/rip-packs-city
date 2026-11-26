// lib/panini/scope.ts
//
// The league / brand SCOPE a visitor picks once and every Panini tab respects (2026-11-26). Pure and
// client-safe (no imports). The scope is a publisher_properties slug carried as `?property=` and remembered
// in localStorage; a tab filters its own rows by the Panini set id each row already carries.
// ⛔ The word "property" is a URL / code word — the control is labelled "League or brand".

export const PANINI_SCOPE_PARAM = "property"
export const PANINI_SCOPE_STORAGE_KEY = "rpc:panini-scope"
export const PANINI_SCOPE_EVENT = "rpc:panini-scope"

export interface PaniniScopeOption {
  slug: string
  name: string
  heading: "leagues" | "entertainment"
  sort_order: number
}

export interface PaniniScopeIndex {
  properties: PaniniScopeOption[]
  /** Panini set id (as a string key) → property slug. */
  setProperty: Record<string, string>
}

/** Pure parse of /api/panini-properties; null = not the expected shape (a failed read). */
export function toScopeIndex(json: unknown): PaniniScopeIndex | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null
  const d = json as Record<string, unknown>
  if (!Array.isArray(d.properties) || !d.setProperty || typeof d.setProperty !== "object" || Array.isArray(d.setProperty)) return null
  const properties: PaniniScopeOption[] = []
  for (const r of d.properties as Record<string, unknown>[]) {
    if (!r || typeof r.slug !== "string" || typeof r.name !== "string") continue
    if (r.heading !== "leagues" && r.heading !== "entertainment") continue
    properties.push({ slug: r.slug, name: r.name, heading: r.heading, sort_order: Number.isFinite(Number(r.sort_order)) ? Number(r.sort_order) : 1000 })
  }
  const setProperty: Record<string, string> = {}
  for (const [k, v] of Object.entries(d.setProperty as Record<string, unknown>)) {
    if (/^\d+$/.test(k) && typeof v === "string" && v) setProperty[k] = v
  }
  return { properties, setProperty }
}

/** The Panini set id inside a card key or sku ("packcard-2332_147_10…" → 2332); null when it carries none. */
export function paniniSetIdOf(key: string | null | undefined): number | null {
  const m = /^packcard-(\d+)_/.exec(String(key ?? ""))
  if (!m) return null
  const n = Number(m[1])
  return Number.isSafeInteger(n) ? n : null
}

/** The property a set id sits under; null = unplaced or unknown. */
export function propertyOfSetId(index: PaniniScopeIndex | null, setId: number | string | null | undefined): string | null {
  if (!index || setId === null || setId === undefined || setId === "") return null
  return index.setProperty[String(setId)] ?? null
}

/** How many rows each property has, for the chips ("NBA · 212"). Rows with no placed set id are not counted. */
export function countByProperty<T>(index: PaniniScopeIndex | null, rows: readonly T[], setIdOf: (row: T) => number | string | null | undefined): Map<string, number> {
  const out = new Map<string, number>()
  if (!index) return out
  for (const r of rows) {
    const p = propertyOfSetId(index, setIdOf(r))
    if (p) out.set(p, (out.get(p) ?? 0) + 1)
  }
  return out
}

/** A valid scope slug is lower-case kebab; anything else is treated as no scope (never passed on). */
export function cleanScopeSlug(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim().toLowerCase()
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s) && s.length <= 40 ? s : ""
}

/** The league / brand's own page (client-safe twin of lib/panini/properties.ts paniniPropertyHref). */
export function paniniScopePageHref(collection: string, slug: string): string {
  return `/${collection}/property/${encodeURIComponent(slug)}`
}
