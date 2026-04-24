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

const ALLOWED_COLLECTIONS = new Set(["nba-top-shot", "nfl-all-day", "la-liga-golazos"])

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

  return NextResponse.json({
    rows: data ?? [],
    total: count ?? (data?.length ?? 0),
    collection_slug: collection,
  })
}
