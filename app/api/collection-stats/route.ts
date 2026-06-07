import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections"

// % of editions whose LATEST FMV snapshot is HIGH or MEDIUM confidence.
// Reframes the misleading "FMV Coverage 100%" — a collection can have a snapshot
// for every edition yet still have ~43% labelled NO_DATA. We surface the share
// of editions priced with usable confidence instead. Pinnacle reads from
// pinnacle_fmv_snapshots (its own per-collection table); everything else uses
// the partitioned fmv_snapshots table keyed by collection_id.
async function computeHighMediumPct(
  slug: string,
): Promise<{ count: number | null; pct: number | null }> {
  try {
    const sql = slug === "disney-pinnacle"
      ? `
          -- PIN-FMV-REKEY Wave 3: per-render coverage from pinnacle_catalog
          -- (one row per render_id) instead of the retiring per-edition blend.
          SELECT
            (SELECT COUNT(*) FROM pinnacle_catalog WHERE fmv_confidence IN ('HIGH','MEDIUM')) AS high_medium,
            (SELECT COUNT(*) FROM pinnacle_catalog) AS edition_total
        `
      : `
          WITH latest AS (
            SELECT DISTINCT ON (edition_id) confidence
            FROM fmv_snapshots
            WHERE collection_id = '${COLLECTION_UUID_BY_SLUG[slug] ?? ""}'
            ORDER BY edition_id, computed_at DESC
          ),
          ed AS (
            SELECT COUNT(*) AS total
            FROM editions
            WHERE collection_id = '${COLLECTION_UUID_BY_SLUG[slug] ?? ""}'
          )
          SELECT
            (SELECT COUNT(*) FROM latest WHERE confidence IN ('HIGH','MEDIUM')) AS high_medium,
            (SELECT total FROM ed) AS edition_total
        `

    const { data, error } = await (supabaseAdmin as any).rpc("query_sql", { query: sql })
    if (error || !data) return { count: null, pct: null }
    const row = Array.isArray(data) ? data[0] : data
    const hm = Number(row?.high_medium ?? 0)
    const total = Number(row?.edition_total ?? 0)
    if (!Number.isFinite(hm) || !Number.isFinite(total) || total <= 0) {
      return { count: hm, pct: null }
    }
    return { count: hm, pct: (hm / total) * 100 }
  } catch {
    return { count: null, pct: null }
  }
}

export async function GET(req: NextRequest) {
  const collection = req.nextUrl.searchParams.get("collection")
  if (!collection) {
    return NextResponse.json({ error: "collection param required" }, { status: 400 })
  }

  const normalized = collection.replace(/-/g, "_")

  try {
    const [statsRes, hmRes] = await Promise.all([
      (supabaseAdmin as any).rpc("get_collection_stats", { p_slug: normalized }),
      computeHighMediumPct(collection),
    ])
    const { data, error } = statsRes

    if (error) {
      return NextResponse.json(
        { error: "stats_unavailable" },
        {
          status: 200,
          headers: {
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
          },
        }
      )
    }

    if (data && typeof data === "object" && !Array.isArray(data) && (data as any).error) {
      return NextResponse.json(data, { status: 404 })
    }

    const enriched =
      data && typeof data === "object" && !Array.isArray(data)
        ? { ...data, fmv_high_medium_count: hmRes.count, fmv_high_medium_pct: hmRes.pct }
        : data

    return NextResponse.json(enriched, {
      headers: {
        "Cache-Control": "s-maxage=300, stale-while-revalidate=60",
        "Access-Control-Allow-Origin": "*",
      },
    })
  } catch {
    return NextResponse.json(
      { error: "stats_unavailable" },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        },
      }
    )
  }
}
