import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { normalizeBadgeKey } from "@/lib/badges/normalize"

// POST /api/badge-taxonomy
// Body: { titles: string[] }
// Returns: { taxonomy: Record<normalizedKey, BadgeMeta> }
//
// Thin wrapper over the get_badge_display_metadata(text[]) Postgres RPC.
// Caller passes any mix of titles / slugs / SCREAMING_SNAKE — both the RPC
// and this route normalize via strip-non-alphanum-lowercase, so matching is
// tolerant. Response is keyed by that normalized key so callers can look up
// their original input by running the same normalization.

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

// Badge taxonomy is near-static, so cache per-normalized-key results in module
// memory (warm across invocations on the same Fluid instance). On a DB-saturation
// wave this route should not touch the DB at all for repeat lookups, killing the
// 5xx-spike class. `meta: null` is a negative-cache entry (a title the RPC has no
// badge for) so unknown titles aren't re-queried every request. On an RPC error
// we serve any cached entry (even expired) instead of 5xx-ing.
const TAXONOMY_TTL_MS = 60 * 60 * 1000 // 1h
type TaxonomyCacheEntry = { meta: BadgeMeta | null; at: number }
const taxonomyCache = new Map<string, TaxonomyCacheEntry>()

export async function POST(req: NextRequest) {
  let body: { titles?: unknown } = {}
  try { body = await req.json() } catch { /* empty body */ }
  const titles = Array.isArray(body.titles) ? body.titles.filter((t): t is string => typeof t === "string") : []
  if (titles.length === 0) {
    return NextResponse.json({ taxonomy: {} })
  }

  const now = Date.now()
  const byKey: Record<string, BadgeMeta> = {}
  const missingTitles: string[] = []
  const missingKeys = new Set<string>()

  // Serve fresh cache hits without touching the DB; collect the rest.
  for (const title of titles) {
    const key = normalizeBadgeKey(title)
    const entry = taxonomyCache.get(key)
    if (entry && now - entry.at <= TAXONOMY_TTL_MS) {
      if (entry.meta) byKey[key] = entry.meta // fresh negative => known no-badge, skip
    } else if (!missingKeys.has(key)) {
      missingKeys.add(key)
      missingTitles.push(title)
    }
  }

  if (missingTitles.length > 0) {
    const { data, error } = await supabase.rpc("get_badge_display_metadata", { p_titles: missingTitles })
    if (error) {
      // Serve stale on DB error instead of 5xx — fall back to any cached entry,
      // even an expired one. This is the spike-killer for saturation windows.
      console.warn(`[badge-taxonomy] RPC error, serving stale where possible: ${error.message}`)
      for (const key of missingKeys) {
        const entry = taxonomyCache.get(key)
        if (entry?.meta) byKey[key] = entry.meta
      }
    } else {
      // RPC returns { canonicalTitle: BadgeMeta }. Re-key by our normalized form
      // so the caller can look up by normalizing the string they already have.
      const returnedKeys = new Set<string>()
      if (data && typeof data === "object") {
        for (const [canonicalTitle, meta] of Object.entries(data as Record<string, BadgeMeta>)) {
          const key = normalizeBadgeKey(canonicalTitle)
          taxonomyCache.set(key, { meta, at: now })
          byKey[key] = meta
          returnedKeys.add(key)
        }
      }
      // Negative-cache requested keys the RPC didn't resolve (no badge for them).
      for (const key of missingKeys) {
        if (!returnedKeys.has(key)) taxonomyCache.set(key, { meta: null, at: now })
      }
    }
  }

  return NextResponse.json({ taxonomy: byKey })
}
