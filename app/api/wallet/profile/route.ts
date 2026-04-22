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
    const rpcStart = Date.now()
    const { data, error } = await (supabaseAdmin as any).rpc("get_user_profile", {
      p_owner_key: rawOwnerKey,
    })
    const rpcMs = Date.now() - rpcStart
    if (error) {
      console.error(
        `[wallet/profile] RPC failed ownerKey=${rawOwnerKey} elapsed=${rpcMs}ms ` +
          `code=${error.code ?? "none"} ` +
          `hint=${(error.hint ?? "none").slice(0, 60)} ` +
          `msg=${(error.message ?? "").slice(0, 120)}`
      )
      console.error(
        `[wallet/profile] RPC details=${JSON.stringify(error.details ?? null).slice(0, 200)}`
      )
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (rpcMs > 3000) {
      console.warn(`[wallet/profile] slow RPC ownerKey=${rawOwnerKey} elapsed=${rpcMs}ms`)
    }
    return NextResponse.json(data)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[wallet/profile] unexpected: ${msg} ownerKey=${rawOwnerKey}`)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
