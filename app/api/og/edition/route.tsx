// app/api/og/edition/route.tsx
// Branded per-edition OG card. GET /api/og/edition?collection=<slug>&slug=<routeSlug>
import { NextRequest } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { getCollection } from "@/lib/collections"
import { renderEntityOg } from "@/lib/og/entity-card"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return ""
  if (Math.abs(n) >= 1000) return "$" + Math.round(n).toLocaleString()
  return "$" + n.toFixed(2)
}

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
  try {
    const { data } = await sb.rpc("get_edition_detail", { p_collection_id: coll.id, p_route_slug: slug })
    detail = Array.isArray(data) ? (data[0] ?? null) : (data ?? null)
  } catch { /* fall through to default */ }

  if (!detail) return renderEntityOg({ eyebrow: label.toUpperCase(), title: "Edition", images: [], accent })

  const fmv = detail.fmv && typeof detail.fmv === "object" ? Number(detail.fmv.fmv_usd) : null
  const hasFmv = fmv !== null && Number.isFinite(fmv) && fmv > 0
  return renderEntityOg({
    eyebrow: `${label.toUpperCase()}${detail.tier ? " · " + String(detail.tier).toUpperCase() : ""}`,
    title: detail.player_name ?? detail.name ?? "Edition",
    subtitle: detail.set_name ?? null,
    accent,
    images: detail.thumbnail_url ? [detail.thumbnail_url] : [],
    statLabel: hasFmv ? "Current FMV" : null,
    statValue: hasFmv ? fmtUsd(fmv) : null,
  })
}
