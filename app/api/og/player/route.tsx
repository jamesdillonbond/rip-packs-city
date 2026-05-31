// app/api/og/player/route.tsx
// Branded per-player OG card. GET /api/og/player?collection=<slug>&slug=<playerSlug>
import { NextRequest } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { getCollection } from "@/lib/collections"
import { renderEntityOg } from "@/lib/og/entity-card"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const collection = sp.get("collection") || ""
  const slug = sp.get("slug") || ""
  const coll = getCollectionByUrlSlug(collection)
  const accent = getCollection(collection)?.accent ?? null
  const label = coll?.displayName ?? "Rip Packs City"
  if (!coll || !slug) return renderEntityOg({ eyebrow: "RIP PACKS CITY", title: label, images: [], accent })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabaseAdmin as any
  let detail: Record<string, any> | null = null
  let firstThumb: string | null = null
  try {
    const [d, eds] = await Promise.all([
      sb.rpc("get_player_detail", { p_collection_id: coll.id, p_player_slug: slug }),
      sb.rpc("get_player_editions", { p_collection_id: coll.id, p_player_slug: slug, p_limit: 1, p_offset: 0 }),
    ])
    detail = Array.isArray(d.data) ? (d.data[0] ?? null) : (d.data ?? null)
    if (Array.isArray(eds.data) && eds.data[0]) firstThumb = eds.data[0].thumbnail_url ?? null
  } catch { /* fall through */ }

  if (!detail) return renderEntityOg({ eyebrow: label.toUpperCase(), title: "Player", images: [], accent })

  const isCharacter = detail.is_character === true
  const portrait = detail.headshot_url ?? firstThumb ?? null
  const editions = detail.edition_count != null ? Number(detail.edition_count) : null
  return renderEntityOg({
    eyebrow: `${label.toUpperCase()} · ${isCharacter ? "CHARACTER" : "PLAYER"}`,
    title: detail.name ?? "Player",
    subtitle: detail.team ?? null,
    accent,
    images: portrait ? [portrait] : [],
    statLabel: editions ? "Editions" : null,
    statValue: editions ? editions.toLocaleString() : null,
  })
}
