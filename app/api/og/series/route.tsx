// app/api/og/series/route.tsx
// Branded per-series OG card (2x2 montage). GET /api/og/series?collection=<slug>&slug=<seriesSlug>
import { NextRequest } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { getCollection } from "@/lib/collections"
import { renderEntityOg } from "@/lib/og/entity-card"
import { boundedRead } from "@/lib/api/bounded-read"
import { OG_FETCH_TIMEOUT_MS } from "@/lib/og/og-fetch"
import { usdSignFirst } from "@/lib/usd-format"
import { seriesPageLabel } from "@/lib/series-label"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function fmtUsd(n: number | null | undefined): string {
  const neg = usdSignFirst(n, fmtUsd); if (neg !== null) return neg
  if (n == null || !Number.isFinite(n)) return ""
  if (Math.abs(n) >= 1000) return "$" + Math.round(n).toLocaleString("en-US")
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
  // A failed detail read is not "no such series": its placeholder must not be cached for a day.
  let readFailed = false
  try {
    const [d, eds] = await Promise.all([
      boundedRead(sb.rpc("get_series_detail", { p_collection_id: coll.id, p_series_slug: slug }), "og/series/get_series_detail", OG_FETCH_TIMEOUT_MS),
      boundedRead(sb.rpc("get_series_editions", { p_collection_id: coll.id, p_series_slug: slug, p_limit: 4, p_offset: 0 }), "og/series/get_series_editions", OG_FETCH_TIMEOUT_MS),
    ])
    if (d.error) readFailed = true
    detail = Array.isArray(d.data) ? (d.data[0] ?? null) : (d.data ?? null)
    images = thumbs(eds.data)
  } catch { readFailed = true }

  if (!detail) return renderEntityOg({ eyebrow: label.toUpperCase(), title: "Series", images, accent, readFailed })

  const edCount = detail.edition_count != null ? Number(detail.edition_count) : null
  const fmvTotal = detail.fmv_total_usd != null ? Number(detail.fmv_total_usd) : null
  // 2026-11-22: the SAME label the series page, its <title> and the Collection tab
  // print (seriesPageLabel → "Series 2023-24" for Top Shot on-chain 6). The raw
  // collection_series.display_label still reads the retired "Series 5/6/7" for
  // Top Shot 6/7/8, so the social card used to contradict the page it previews.
  const seriesNumber = detail.series_number != null && Number.isFinite(Number(detail.series_number)) ? Number(detail.series_number) : null
  const title = seriesPageLabel(seriesNumber, detail.display_label ?? null, collection)
  const season = detail.season ? String(detail.season) : null
  const countLine = edCount ? `${edCount.toLocaleString("en-US")} ${edCount === 1 ? "edition" : "editions"}` : null
  return renderEntityOg({
    eyebrow: `${label.toUpperCase()} · SERIES`,
    title,
    // Skip the season line when the title already IS the season ("Series 2023-24").
    subtitle: season && !title.includes(season) ? season : countLine,
    accent,
    images,
    statLabel: fmvTotal && fmvTotal > 0 ? "Aggregate FMV" : null,
    statValue: fmvTotal && fmvTotal > 0 ? fmtUsd(fmvTotal) : null,
  })
}
