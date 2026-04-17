import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { toDbSlug } from "@/lib/collections"

// Thin wrapper around the collection_readiness() Postgres function.
// Returns the full readiness map by default; pass ?collection=<slug> to narrow
// to one collection (accepts either the frontend hyphen slug or the DB
// underscore slug).

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("collection")?.trim() || null
  const dbSlug = raw ? toDbSlug(raw) ?? raw : null

  try {
    const params = dbSlug ? { p_slug: dbSlug } : {}
    const { data, error } = await (supabaseAdmin as any).rpc(
      "collection_readiness",
      params
    )
    if (error) {
      console.log("[collection-readiness] rpc error:", error.message)
      return NextResponse.json({ error: "Query failed" }, { status: 500 })
    }

    const res = NextResponse.json(data ?? {})
    res.headers.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600")
    return res
  } catch (err) {
    console.log(
      "[collection-readiness] error:",
      err instanceof Error ? err.message : String(err)
    )
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
