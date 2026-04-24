import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { normalizePackRetailPrice } from "@/lib/packs/normalize-retail-price"

const supabaseAdmin: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"

export async function GET() {
  const rows: any[] = []
  const pageSize = 1000
  let from = 0

  while (true) {
    const { data, error } = await supabaseAdmin
      .from("pack_distributions")
      .select("dist_id, title, nft_type, metadata")
      .eq("collection_id", ALLDAY_COLLECTION_ID)
      .order("dist_id", { ascending: true })
      .range(from, from + pageSize - 1)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!data || data.length === 0) break
    rows.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }

  for (const r of rows) {
    if (r.metadata && r.metadata.retail_price_usd != null) {
      r.metadata.retail_price_usd = normalizePackRetailPrice(r.metadata.retail_price_usd)
    }
  }

  return NextResponse.json({ distributions: rows, count: rows.length })
}
