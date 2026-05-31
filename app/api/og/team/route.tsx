// app/api/og/team/route.tsx
// Branded per-team OG card (2x2 montage). GET /api/og/team?collection=<slug>&slug=<teamSlug>
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
function thumbs(rows: unknown): string[] {
  if (!Array.isArray(rows)) return []
  return rows.map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>).thumbnail_url : null)).filter((u): u is string => typeof u === "string")
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
  let images: string[] = []
  try {
    const [d, eds] = await Promise.all([
      sb.rpc("get_team_detail", { p_collection_id: coll.id, p_team_slug: slug }),
      sb.rpc("get_team_top_editions", { p_collection_id: coll.id, p_team_slug: slug, p_limit: 4, p_offset: 0 }),
    ])
    detail = Array.isArray(d.data) ? (d.data[0] ?? null) : (d.data ?? null)
    images = thumbs(eds.data)
  } catch { /* fall through */ }

  if (!detail) return renderEntityOg({ eyebrow: label.toUpperCase(), title: "Team", images, accent })

  const isFranchise = detail.is_franchise === true
  const edCount = detail.edition_count != null ? Number(detail.edition_count) : null
  const fmvTotal = detail.fmv_total_usd != null ? Number(detail.fmv_total_usd) : null
  return renderEntityOg({
    eyebrow: `${label.toUpperCase()} · ${isFranchise ? "FRANCHISE" : "TEAM"}`,
    title: detail.team_name ?? "Team",
    subtitle: edCount ? `${edCount.toLocaleString()} editions` : null,
    accent,
    images,
    statLabel: fmvTotal && fmvTotal > 0 ? "Aggregate FMV" : null,
    statValue: fmvTotal && fmvTotal > 0 ? fmtUsd(fmvTotal) : null,
  })
}
