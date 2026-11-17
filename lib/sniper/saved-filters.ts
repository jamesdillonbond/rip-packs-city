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

// ── "Alert me" from the Sniper (2026-10-24) ──────────────────────────────────
// The retained collector's loop was filter → scan → buy; the alert that would
// do the scanning for them lived on another page with every filter re-typed.
// The board's filters travel to /alerts as query params, which AlertsClient
// reads once to prefill a NEW alert (nothing is saved until they press Save).

// On Disney Pinnacle the Sniper's "tier" tab is a pin VARIANT ("Golden", "Radiant Chrome"). The deals view carries
// it mixed-case and dispatch_due_deal_alerts matches `tiers` case-SENSITIVELY, so an uppercased "GOLDEN" in tiers
// never fired (2026-10-27). A variant travels as `parallel` instead — the alert's parallel filter matches the
// Pinnacle variant case-insensitively — and is never uppercased.
export function sniperAlertHref(f: { collectionUuid: string | null; tier?: string; player?: string; team?: string; maxPrice?: number; minDiscount?: number; tierIsVariant?: boolean }): string | null {
  if (!f.collectionUuid) return null
  const q = new URLSearchParams({ from: "sniper", collection: f.collectionUuid })
  if (f.tier && f.tier !== "all") {
    if (f.tierIsVariant) q.set("parallel", f.tier.slice(0, 80))
    else q.set("tier", f.tier.toUpperCase())
  }
  if (f.player) q.set("player", f.player.slice(0, 80))
  if (f.team && f.team !== "all") q.set("team", f.team.slice(0, 80))
  if (f.maxPrice && f.maxPrice > 0) q.set("maxPrice", String(f.maxPrice))
  if (f.minDiscount && f.minDiscount > 0) q.set("minDiscount", String(f.minDiscount))
  return `/alerts?${q.toString()}`
}

export type AlertPrefill = { collectionId: string; tier?: string; parallel?: string; player?: string; team?: string; maxPrice?: string; minDiscount?: string }

/** Reads a /alerts?from=sniper… query; null unless it came from the Sniper with a collection. */
export function readAlertPrefill(search: string): AlertPrefill | null {
  const q = new URLSearchParams(search)
  if (q.get("from") !== "sniper") return null
  const collectionId = q.get("collection")
  if (!collectionId || !/^[0-9a-f-]{36}$/i.test(collectionId)) return null
  const num = (v: string | null) => (v && /^\d+(\.\d+)?$/.test(v) ? v : undefined)
  return {
    collectionId,
    tier: q.get("tier")?.toUpperCase() || undefined,
    parallel: q.get("parallel")?.slice(0, 80) || undefined,
    player: q.get("player")?.slice(0, 80) || undefined,
    team: q.get("team")?.slice(0, 80) || undefined,
    maxPrice: num(q.get("maxPrice")),
    minDiscount: num(q.get("minDiscount")),
  }
}
