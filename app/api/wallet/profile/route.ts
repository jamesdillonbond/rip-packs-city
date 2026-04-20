import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export async function GET(req: NextRequest) {
  const rawOwnerKey = req.nextUrl.searchParams.get("ownerKey")?.trim() ?? ""

  // Reject missing, empty, and common null-like string coercions that
  // crawlers / buggy client code produce when localStorage is empty.
  if (!rawOwnerKey || rawOwnerKey === "null" || rawOwnerKey === "undefined") {
    return NextResponse.json({ error: "ownerKey param required" }, { status: 400 })
  }

  try {
    const { data, error } = await (supabaseAdmin as any).rpc("get_user_profile", {
      p_owner_key: rawOwnerKey,
    })
    if (error) {
      console.error(
        `[wallet/profile] RPC error: ${error.message} ownerKey=${rawOwnerKey}`
      )
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json(data)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[wallet/profile] unexpected: ${msg} ownerKey=${rawOwnerKey}`)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
