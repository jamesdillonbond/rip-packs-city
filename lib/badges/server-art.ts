import { supabaseAdmin } from "@/lib/supabase"
import { normalizeBadgeKey } from "./normalize"

// Server-side resolver for real badge ARTWORK (the SVGs Trevor wants in place
// of ALL-CAPS text pills). get_badge_display_metadata returns
// { canonicalTitle: { icon_url, ... } } for the badges whose art exists
// (proxied via /api/badge-image). Returns a map of normalized-title -> icon_url
// so server components can render the image; badges with no art are absent and
// the caller falls back to a text pill. Client surfaces get the same data via
// the BadgeRow / BadgeIcon taxonomy hook. (2026-06-15)
//
// Pass `collectionId` to resolve collection-correct art: e.g. NFL All Day's
// "Rookie Year" / "Championship Year" badges share a title with Top Shot but
// have their own SVGs, so the lookup is collection-aware. Omit it (or pass null)
// for the Top Shot / collection-agnostic path. (2026-06-29)
export async function fetchBadgeArt(
  titles: string[],
  collectionId?: string | null,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unique = Array.from(new Set(titles.filter(Boolean)))
  if (unique.length === 0) return out
  try {
    const { data, error } = await (supabaseAdmin as any).rpc("get_badge_display_metadata", {
      p_titles: unique,
      p_collection_id: collectionId ?? null,
    })
    if (error) {
      console.warn(`[badge-art] rpc: ${error.message}`)
      return out
    }
    if (data && typeof data === "object") {
      for (const [canonicalTitle, meta] of Object.entries(
        data as Record<string, { icon_url?: string | null }>,
      )) {
        const iconUrl = meta?.icon_url
        if (iconUrl) out.set(normalizeBadgeKey(canonicalTitle), iconUrl)
      }
    }
  } catch (err) {
    console.warn(`[badge-art] threw: ${err instanceof Error ? err.message : String(err)}`)
  }
  return out
}
