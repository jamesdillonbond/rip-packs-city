import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")
  if (!wallet) return NextResponse.json({ error: "wallet required" }, { status: 400 })

  const collectionId = req.nextUrl.searchParams.get("collection_id") || "95f28a17-224a-4025-96ad-adf8a4c63bfd"

  const { data, error } = await supabase.rpc("get_wallet_summary", {
    p_wallet: wallet,
    p_collection_id: collectionId,
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
