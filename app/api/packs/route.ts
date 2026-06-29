import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// GET /api/packs?collection=<slug>&sort=<key>&tier=<tier>&search=<q>&limit=<n>
//
// Reads from the `pack_table_rows` view — the unified pack catalog shared by
// Top Shot, All Day, and Golazos. Returns PackTable-ready rows.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// la-liga-golazos packs surface removed 2026-05-19 — see lib/collections.ts.
// pack_table_rows still returns Golazos rows but no UI surface consumes them.
const ALLOWED_COLLECTIONS = new Set(["nba-top-shot", "nfl-all-day"])

type SortKey = "value_ratio_desc" | "ev_margin_pct_desc" | "retail_price_asc" | "title_asc"
const ALLOWED_SORTS = new Set<SortKey>([
  "value_ratio_desc",
  "ev_margin_pct_desc",
  "retail_price_asc",
  "title_asc",
])

function sortToColumn(sort: SortKey): { column: string; ascending: boolean; nullsFirst: boolean } {
  switch (sort) {
    case "value_ratio_desc":
      return { column: "value_ratio", ascending: false, nullsFirst: false }
    case "ev_margin_pct_desc":
      return { column: "ev_margin_pct", ascending: false, nullsFirst: false }
    case "retail_price_asc":
      return { column: "retail_price_usd", ascending: true, nullsFirst: false }
    case "title_asc":
      return { column: "title", ascending: true, nullsFirst: false }
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const collection = url.searchParams.get("collection") ?? ""
  const sortParam = (url.searchParams.get("sort") ?? "value_ratio_desc") as SortKey
  const tier = url.searchParams.get("tier")?.trim() || null
  const search = url.searchParams.get("search")?.trim() || null
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "100", 10)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 1000) : 100

  if (!ALLOWED_COLLECTIONS.has(collection)) {
    return NextResponse.json(
      { error: "collection must be one of: " + Array.from(ALLOWED_COLLECTIONS).join(", ") },
      { status: 400 },
    )
  }
  const sort: SortKey = ALLOWED_SORTS.has(sortParam) ? sortParam : "value_ratio_desc"
  const { column, ascending, nullsFirst } = sortToColumn(sort)

  let query = supabase
    .from("pack_table_rows")
    .select("*", { count: "exact" })
    .eq("collection_slug", collection)

  if (tier) query = query.eq("tier", tier)
  if (search) query = query.ilike("title", "%" + search + "%")

  const { data, count, error } = await query
    .order(column, { ascending, nullsFirst })
    .limit(limit)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  let rows = data ?? []

  // Reality-adjusted EV (Top Shot only): merge v_topshot_pack_ev_calibrated by
  // dist_id so the packs page can headline calibrated EV where we have enough
  // observed opens. The view is TS-only (~800 rows) and bakes in the
  // modeled-fallback, so we fetch it whole and map by dist_id. Non-fatal: if it
  // errors the page just shows pure modeled EV.
  if (collection === "nba-top-shot" && rows.length) {
    const { data: calData, error: calError } = await supabase
      .from("v_topshot_pack_ev_calibrated")
      .select(
        "dist_id, calibrated_gross_ev, calibrated_net_ev, calibrated_margin_pct, calibration_applied",
      )
      .eq("calibration_applied", true)
      .limit(2000)
    if (calError) {
      console.error("[api/packs] calibrated merge", calError.message)
    } else if (calData?.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calMap = new Map<string, any>(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (calData as any[]).map((c) => [String(c.dist_id), c]),
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rows = (rows as any[]).map((r) => {
        const c = calMap.get(String(r.dist_id))
        return c
          ? {
              ...r,
              calibrated_gross_ev: c.calibrated_gross_ev,
              calibrated_net_ev: c.calibrated_net_ev,
              calibrated_margin_pct: c.calibrated_margin_pct,
              calibration_applied: c.calibration_applied,
            }
          : r
      })
    }
  }

  // Corrected EV (NFL All Day only): the canonical AllDay EV is a flat
  // top-10%-trimmed avg(fmv) × slots that ignores pull odds — it over-states
  // rare-heavy packs (a $4 pack modeled at $430). v_allday_pack_info exposes an
  // odds/median-robust corrected EV; overwrite the canonical display columns
  // with it (mirrors the TS calibrated headline) so the list and the dist page
  // agree, and attach low_confidence_ev/ev_method for the caveat chip. Non-fatal.
  if (collection === "nfl-all-day" && rows.length) {
    const { data: corr, error: corrError } = await supabase
      .from("v_allday_pack_info")
      .select("dist_id, corrected_gross_ev, corrected_net_ev, corrected_value_ratio, ev_method, low_confidence_ev")
      .limit(4000)
    if (corrError) {
      console.error("[api/packs] allday corrected merge", corrError.message)
    } else if (corr?.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const corrMap = new Map<string, any>(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (corr as any[]).map((c) => [String(c.dist_id), c]),
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rows = (rows as any[]).map((r) => {
        const c = corrMap.get(String(r.dist_id))
        if (!c || c.corrected_gross_ev == null) return r
        const ratio = c.corrected_value_ratio == null ? null : Number(c.corrected_value_ratio)
        return {
          ...r,
          gross_ev: c.corrected_gross_ev,
          pack_ev: c.corrected_net_ev,
          value_ratio: c.corrected_value_ratio,
          // Same scale the view stores: (net/price)*100 = (value_ratio-1)*100.
          ev_margin_pct: ratio === null ? r.ev_margin_pct : (ratio - 1) * 100,
          low_confidence_ev: c.low_confidence_ev,
          ev_method: c.ev_method,
        }
      })
    }
  }

  return NextResponse.json(
    {
      rows,
      total: count ?? (rows.length ?? 0),
      collection_slug: collection,
    },
    {
      // Global pack catalog (pack_table_rows by collection_slug) — not
      // user-specific, safe to share at the edge. Warms cold pack-page loads.
      headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=240" },
    },
  )
}
