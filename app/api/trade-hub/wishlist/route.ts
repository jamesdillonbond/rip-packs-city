// app/api/trade-hub/wishlist/route.ts
//
// CRUD for user_wishlists. Auth: Supabase cookie. user_id is always pinned to
// the signed-in user server-side. Clients can't write a foreign user_id.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCurrentUser } from "@/lib/auth/supabase-server"

export const dynamic = "force-dynamic"

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 })

  const { data, error } = await (supabaseAdmin as any)
    .from("user_wishlists")
    .select("id, edition_id, collection_id, max_price_usd, serial_constraints, notes, created_at, updated_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, wishlist: data ?? [] })
}

interface PostBody {
  edition_id?: string
  collection_id?: string
  max_price_usd?: number | null
  notes?: string | null
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 })

  let body: PostBody
  try { body = (await req.json()) as PostBody } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!body.edition_id || !body.collection_id) {
    return NextResponse.json({ error: "edition_id and collection_id required" }, { status: 400 })
  }

  const row = {
    user_id: user.id,
    edition_id: body.edition_id,
    collection_id: body.collection_id,
    max_price_usd: body.max_price_usd ?? null,
    notes: body.notes ?? null,
  }

  const { data, error } = await (supabaseAdmin as any)
    .from("user_wishlists")
    .upsert(row, { onConflict: "user_id,edition_id" })
    .select("id")
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, id: data?.id ?? null })
}

export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 })

  const id = req.nextUrl.searchParams.get("id")
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  const { error } = await (supabaseAdmin as any)
    .from("user_wishlists")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
