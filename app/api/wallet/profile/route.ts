import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export async function GET(req: NextRequest) {
  const ownerKey = req.nextUrl.searchParams.get("ownerKey")
  if (!ownerKey) {
    return NextResponse.json({ error: "ownerKey param required" }, { status: 400 })
  }

  const { data, error } = await (supabaseAdmin as any).rpc("get_user_profile", {
    p_owner_key: ownerKey,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data)
}
