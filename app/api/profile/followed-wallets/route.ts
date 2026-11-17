// app/api/profile/followed-wallets/route.ts
//
// Follow a WALLET without saving it as your own (2026-11-16). Saving is the
// "this is me" path — it fills the binder and FMV totals and can claim the
// wallet's handle as your public profile — so it is the wrong tool for keeping
// an eye on a friend. `follows` (member → member) cannot follow a friend who
// never signed up. This route can. Friend Activity (/api/profile/activity)
// reads both.
//
//   GET ?wallet=<addr>  — probe: { authed, following, own } (anon → authed:false, never 401)
//   GET                 — list: { wallets: [{ wallet_addr, username, created_at }] }
//   POST   { wallet }   — follow
//   DELETE { wallet }   — unfollow
//
// THREE states, never two: a failed read answers an error status, never
// "not following" / "not yours".

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { getCurrentUser, requireUser } from "@/lib/auth/supabase-server"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { MAX_FOLLOWED_WALLETS, parseFollowedWallet as parseWallet, savedWalletAddressVariants as addressVariants } from "@/lib/profile/followed-wallets"
import { resolveUsernames, nameKey } from "@/lib/flowty-username"

export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" }

type OwnRead = { ok: true; own: boolean } | { ok: false; error: unknown }

async function isOwnWallet(userId: string, addr: string): Promise<OwnRead> {
  const { data, error } = await boundedRead(supabase
    .from("saved_wallets")
    .select("wallet_addr")
    .eq("user_id", userId)
    .in("wallet_addr", addressVariants(addr))
    .limit(1), "api/profile/followed-wallets/own")
  if (error) return { ok: false, error }
  return { ok: true, own: (data ?? []).length > 0 }
}

async function readBody(req: NextRequest): Promise<string | null> {
  try {
    const body = (await req.json()) as { wallet?: unknown } | null
    return parseWallet(body?.wallet)
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  const probe = req.nextUrl.searchParams.get("wallet")
  if (probe !== null) {
    const addr = parseWallet(probe)
    if (!addr) return NextResponse.json({ error: "wallet must be an on-chain address" }, { status: 400, headers: NO_STORE })
    const viewer = await getCurrentUser()
    if (!viewer) return NextResponse.json({ authed: false, following: false, own: false }, { headers: NO_STORE })

    const [own, edge] = await Promise.all([
      isOwnWallet(viewer.id, addr),
      boundedRead(supabase
        .from("followed_wallets")
        .select("wallet_addr")
        .eq("follower_user_id", viewer.id)
        .eq("wallet_addr", addr)
        .maybeSingle(), "api/profile/followed-wallets/probe"),
    ])
    if (!own.ok) return apiErrorResponse(own.error, "api/profile/followed-wallets/probe")
    if (edge.error) return apiErrorResponse(edge.error, "api/profile/followed-wallets/probe")
    return NextResponse.json({ authed: true, following: !!edge.data, own: own.own }, { headers: NO_STORE })
  }

  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }
  const { data, error } = await boundedRead(supabase
    .from("followed_wallets")
    .select("wallet_addr, created_at")
    .eq("follower_user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(MAX_FOLLOWED_WALLETS), "api/profile/followed-wallets/list")
  if (error) return apiErrorResponse(error, "api/profile/followed-wallets")
  const rows = (data ?? []) as { wallet_addr: string; created_at: string }[]
  // Names are attribution only: a failed lookup leaves username null, it does
  // not fail the list.
  let names = new Map<string, string>()
  try {
    names = await resolveUsernames(rows.map((r) => r.wallet_addr))
  } catch (e) {
    console.error("[followed-wallets] names unavailable:", e)
  }
  return NextResponse.json(
    {
      wallets: rows.map((r) => ({
        wallet_addr: r.wallet_addr,
        username: names.get(nameKey(r.wallet_addr)) ?? null,
        created_at: r.created_at,
      })),
    },
    { headers: NO_STORE },
  )
}

export async function POST(req: NextRequest) {
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }
  const addr = await readBody(req)
  if (!addr) return NextResponse.json({ error: "wallet must be an on-chain address" }, { status: 400 })

  const own = await isOwnWallet(user.id, addr)
  if (!own.ok) return apiErrorResponse(own.error, "api/profile/followed-wallets")
  if (own.own) {
    return NextResponse.json({ error: "own_wallet", message: "This wallet is already saved as yours." }, { status: 409 })
  }

  const { count, error: cErr } = await boundedRead(supabase
    .from("followed_wallets")
    .select("wallet_addr", { count: "exact", head: true })
    .eq("follower_user_id", user.id), "api/profile/followed-wallets/count")
  if (cErr) return apiErrorResponse(cErr, "api/profile/followed-wallets")
  if (count == null) return apiErrorResponse(new Error("follow count unavailable"), "api/profile/followed-wallets")
  if (count >= MAX_FOLLOWED_WALLETS) {
    return NextResponse.json(
      { error: "limit", message: `You can follow up to ${MAX_FOLLOWED_WALLETS} wallets. Unfollow one to add another.` },
      { status: 409 },
    )
  }

  const { error } = await supabase
    .from("followed_wallets")
    .upsert({ follower_user_id: user.id, wallet_addr: addr }, { onConflict: "follower_user_id,wallet_addr" })
  if (error) return apiErrorResponse(error, "api/profile/followed-wallets")
  return NextResponse.json({ ok: true, wallet_addr: addr })
}

export async function DELETE(req: NextRequest) {
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }
  const addr = await readBody(req)
  if (!addr) return NextResponse.json({ error: "wallet must be an on-chain address" }, { status: 400 })
  const { error } = await supabase
    .from("followed_wallets")
    .delete()
    .eq("follower_user_id", user.id)
    .eq("wallet_addr", addr)
  if (error) return apiErrorResponse(error, "api/profile/followed-wallets")
  return NextResponse.json({ ok: true })
}
