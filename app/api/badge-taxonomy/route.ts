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

export async function POST(req: NextRequest) {
  let body: { titles?: unknown } = {}
  try { body = await req.json() } catch { /* empty body */ }
  const titles = Array.isArray(body.titles) ? body.titles.filter((t): t is string => typeof t === "string") : []
  if (titles.length === 0) {
    return NextResponse.json({ taxonomy: {} })
  }

  const { data, error } = await supabase.rpc("get_badge_display_metadata", { p_titles: titles })
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // RPC returns { canonicalTitle: BadgeMeta }. Re-key by our normalized form so
  // the caller can look up by normalizing the string they already have.
  const byKey: Record<string, BadgeMeta> = {}
  if (data && typeof data === "object") {
    for (const [canonicalTitle, meta] of Object.entries(data as Record<string, BadgeMeta>)) {
      byKey[normalizeBadgeKey(canonicalTitle)] = meta
    }
  }
  return NextResponse.json({ taxonomy: byKey })
}
