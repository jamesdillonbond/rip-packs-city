import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: NextRequest) {
  const tag = req.nextUrl.searchParams.get("tag")
  const username = req.nextUrl.searchParams.get("username")

  let query = supabase
    .from("seeded_wallets")
    .select("username, wallet_address, display_name, tags, priority, is_active, last_refreshed_at, cached_moment_count, cached_fmv_usd, cached_top_tier, is_pro_user")
    .eq("is_active", true)

  if (username) query = query.ilike("username", username.trim())
  if (tag) query = query.contains("tags", [tag])

  const { data, error } = await query.order("priority", { ascending: true }).order("cached_fmv_usd", { ascending: false, nullsFirst: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json(
    { wallets: data ?? [] },
    { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } }
  )
}
