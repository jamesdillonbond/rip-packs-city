// app/api/trade-hub/offers/route.ts
//
// CRUD for user_trade_offers. Auth: Supabase cookie. user_id is pinned to the
// signed-in user; clients can't write a foreign user_id.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCurrentUser } from "@/lib/auth/supabase-server"

export const dynamic = "force-dynamic"

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 })

  const { data, error } = await (supabaseAdmin as any)
    .from("user_trade_offers")
    .select("id, wallet_address, moment_id, edition_id, collection_id, ask_price_usd, open_to_trades, notes, expires_at, status, created_at, updated_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, offers: data ?? [] })
}

interface PostBody {
  wallet_address?: string
  moment_id?: string
  edition_id?: string
  collection_id?: string
  ask_price_usd?: number | null
  open_to_trades?: boolean
  notes?: string | null
  expires_at?: string | null
  status?: string
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 })

  let body: PostBody
  try { body = (await req.json()) as PostBody } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!body.wallet_address || !body.moment_id || !body.edition_id || !body.collection_id) {
    return NextResponse.json({ error: "wallet_address, moment_id, edition_id, collection_id required" }, { status: 400 })
  }

  const row = {
    user_id: user.id,
    wallet_address: body.wallet_address,
    moment_id: body.moment_id,
    edition_id: body.edition_id,
    collection_id: body.collection_id,
    ask_price_usd: body.ask_price_usd ?? null,
    open_to_trades: body.open_to_trades ?? true,
    notes: body.notes ?? null,
    expires_at: body.expires_at ?? null,
    status: body.status ?? "open",
  }

  const { data, error } = await (supabaseAdmin as any)
    .from("user_trade_offers")
    .upsert(row, { onConflict: "user_id,moment_id" })
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
    .from("user_trade_offers")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
