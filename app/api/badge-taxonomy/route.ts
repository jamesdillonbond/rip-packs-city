import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { normalizeBadgeKey } from "@/lib/badges/normalize"

// POST /api/badge-taxonomy
// Body: { titles: string[], collectionId?: string }
// Returns: { taxonomy: Record<normalizedKey, BadgeMeta> }
//
// Thin wrapper over the get_badge_display_metadata(text[], uuid) Postgres RPC.
// Caller passes any mix of titles / slugs / SCREAMING_SNAKE — both the RPC
// and this route normalize via strip-non-alphanum-lowercase, so matching is
// tolerant. Response is keyed by that normalized key so callers can look up
// their original input by running the same normalization.
//
// `collectionId` (optional) makes art collection-aware: NFL All Day's Rookie
// Year / Championship Year etc. share a title with Top Shot but have their own
// SVGs, so the cache + RPC are keyed by collection. Omitted → Top Shot /
// collection-agnostic behavior (unchanged). (2026-06-29)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export interface BadgeMeta {
  title: string
  category: string
  color_family: string
  icon_url: string | null
  priority: number
  description: string | null
}

// Badge taxonomy is near-static, so cache per-(collection,normalized-key) results
// in module memory. `meta: null` is a negative-cache entry (a title the RPC has
// no badge for). On an RPC error we serve any cached entry (even expired) instead
// of 5xx-ing. The cache key includes collectionId so collection-specific art
// (NFL vs Top Shot) never collides.
const TAXONOMY_TTL_MS = 60 * 60 * 1000 // 1h
type TaxonomyCacheEntry = { meta: BadgeMeta | null; at: number }
const taxonomyCache = new Map<string, TaxonomyCacheEntry>()

function cacheKeyFor(collectionId: string | null, normalizedKey: string): string {
  return `${collectionId ?? ""}:${normalizedKey}`
}

export async function POST(req: NextRequest) {
  let body: { titles?: unknown; collectionId?: unknown } = {}
  try { body = await req.json() } catch { /* empty body */ }
  const titles = Array.isArray(body.titles) ? body.titles.filter((t): t is string => typeof t === "string") : []
  const collectionId = typeof body.collectionId === "string" && body.collectionId ? body.collectionId : null
  if (titles.length === 0) {
    return NextResponse.json({ taxonomy: {} })
  }

  const now = Date.now()
  const byKey: Record<string, BadgeMeta> = {}
  const missingTitles: string[] = []
  const missingKeys = new Set<string>() // cache keys (collection-scoped)
  const missingNormByCacheKey = new Map<string, string>() // cacheKey -> normalizedKey

  // Serve fresh cache hits without touching the DB; collect the rest.
  for (const title of titles) {
    const nk = normalizeBadgeKey(title)
    const ck = cacheKeyFor(collectionId, nk)
    const entry = taxonomyCache.get(ck)
    if (entry && now - entry.at <= TAXONOMY_TTL_MS) {
      if (entry.meta) byKey[nk] = entry.meta // fresh negative => known no-badge, skip
    } else if (!missingKeys.has(ck)) {
      missingKeys.add(ck)
      missingNormByCacheKey.set(ck, nk)
      missingTitles.push(title)
    }
  }

  if (missingTitles.length > 0) {
    const { data, error } = await supabase.rpc("get_badge_display_metadata", {
      p_titles: missingTitles,
      p_collection_id: collectionId,
    })
    if (error) {
      console.warn(`[badge-taxonomy] RPC error, serving stale where possible: ${error.message}`)
      for (const ck of missingKeys) {
        const entry = taxonomyCache.get(ck)
        if (entry?.meta) byKey[missingNormByCacheKey.get(ck)!] = entry.meta
      }
    } else {
      const returnedKeys = new Set<string>()
      if (data && typeof data === "object") {
        for (const [canonicalTitle, meta] of Object.entries(data as Record<string, BadgeMeta>)) {
          const nk = normalizeBadgeKey(canonicalTitle)
          const ck = cacheKeyFor(collectionId, nk)
          taxonomyCache.set(ck, { meta, at: now })
          byKey[nk] = meta
          returnedKeys.add(ck)
        }
      }
      for (const ck of missingKeys) {
        if (!returnedKeys.has(ck)) taxonomyCache.set(ck, { meta: null, at: now })
      }
    }
  }

  return NextResponse.json({ taxonomy: byKey })
}
