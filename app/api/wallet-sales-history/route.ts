// app/api/wallet-sales-history/route.ts
//
// GET /api/wallet-sales-history?wallet=0x...|username&collection=<slug>&limit=10
// Returns the latest N sales (buy or sell) for the wallet within a single collection.
//
// TopShot caveat: TopShot's centralized marketplace masks buyer addresses, so the
// common case for a TopShot wallet is "only sells visible". We surface a `note`
// flag on the response so the UI can explain the asymmetry.
//
// Pinnacle uses pinnacle_sales joined to pinnacle_editions (text IDs, not UUIDs).

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { topshotGraphql } from "@/lib/topshot"
import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections"

const TOPSHOT_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const PINNACLE_UUID = "7dd9dd11-e8b6-45c4-ac99-71331f959714"

type UsernameProfileResponse = {
  getUserProfileByUsername?: { publicInfo?: { flowAddress?: string | null } | null } | null
}

async function resolveWallet(input: string): Promise<string> {
  const t = input.trim()
  if (t.startsWith("0x") && t.length === 18) return t
  const query = `
    query GetUserProfileByUsername($username: String!) {
      getUserProfileByUsername(input: { username: $username }) {
        publicInfo { flowAddress }
      }
    }
  `
  const data = await topshotGraphql<UsernameProfileResponse>(query, { username: t.replace(/^@+/, "") })
  const raw = data?.getUserProfileByUsername?.publicInfo?.flowAddress ?? null
  if (!raw) throw new Error("Could not resolve username to wallet address.")
  return raw.startsWith("0x") ? raw : `0x${raw}`
}

type SaleRow = {
  player_name: string | null
  set_name: string | null
  tier: string | null
  serial_number: number | null
  price_usd: number
  marketplace: string | null
  sold_at: string
  side: "buy" | "sell"
}

export async function GET(req: NextRequest) {
  try {
    const walletInput = req.nextUrl.searchParams.get("wallet")
    if (!walletInput) return NextResponse.json({ error: "wallet required" }, { status: 400 })

    const collectionSlug = req.nextUrl.searchParams.get("collection")?.trim() || ""
    const collectionUuid = COLLECTION_UUID_BY_SLUG[collectionSlug]
    if (!collectionUuid) {
      return NextResponse.json({ error: `unknown collection: ${collectionSlug}` }, { status: 400 })
    }

    const limitRaw = Number(req.nextUrl.searchParams.get("limit") ?? 10)
    const limit = Math.max(1, Math.min(50, Number.isFinite(limitRaw) ? limitRaw : 10))

    const wallet = await resolveWallet(walletInput)
    const walletLower = wallet.toLowerCase()

    let rows: SaleRow[] = []

    if (collectionUuid === PINNACLE_UUID) {
      // Pinnacle path — pinnacle_sales joined to pinnacle_editions (text IDs).
      const { data, error } = await (supabaseAdmin as any)
        .from("pinnacle_sales")
        .select("sale_price_usd, sold_at, source, serial_number, buyer_address, seller_address, edition_id, pinnacle_editions:edition_id(character_name, set_name, edition_type)")
        .or(`buyer_address.eq.${wallet},seller_address.eq.${wallet}`)
        .order("sold_at", { ascending: false })
        .limit(limit)
      if (error) throw new Error(error.message)
      rows = (data ?? []).map((r: any) => {
        const edition = Array.isArray(r.pinnacle_editions) ? r.pinnacle_editions[0] : r.pinnacle_editions
        const isBuyer = (r.buyer_address ?? "").toLowerCase() === walletLower
        return {
          player_name: edition?.character_name ?? null,
          set_name: edition?.set_name ?? null,
          tier: edition?.edition_type ?? null,
          serial_number: r.serial_number ?? null,
          price_usd: Number(r.sale_price_usd) || 0,
          marketplace: r.source ?? null,
          sold_at: r.sold_at,
          side: isBuyer ? "buy" : "sell",
        }
      })
    } else {
      // sales joined to editions (uuid IDs).
      const { data, error } = await (supabaseAdmin as any)
        .from("sales")
        .select("price_usd, sold_at, marketplace, serial_number, buyer_address, seller_address, edition_id, editions:edition_id(player_name, set_name, tier)")
        .eq("collection_id", collectionUuid)
        .or(`buyer_address.eq.${wallet},seller_address.eq.${wallet}`)
        .order("sold_at", { ascending: false })
        .limit(limit)
      if (error) throw new Error(error.message)
      rows = (data ?? []).map((r: any) => {
        const edition = Array.isArray(r.editions) ? r.editions[0] : r.editions
        const isBuyer = (r.buyer_address ?? "").toLowerCase() === walletLower
        return {
          player_name: edition?.player_name ?? null,
          set_name: edition?.set_name ?? null,
          tier: edition?.tier ?? null,
          serial_number: r.serial_number ?? null,
          price_usd: Number(r.price_usd) || 0,
          marketplace: r.marketplace ?? null,
          sold_at: r.sold_at,
          side: isBuyer ? "buy" : "sell",
        }
      })
    }

    console.log("[wallet-sales-history]", wallet, collectionSlug, rows.length)

    const onlySells = rows.length > 0 && rows.every((r) => r.side === "sell")
    const note = collectionUuid === TOPSHOT_UUID && onlySells
      ? "Buy-side wallet identities aren't exposed by Top Shot's centralized marketplace — only Flowty trades and outbound sells are visible"
      : undefined

    return NextResponse.json(
      { wallet, collection: collectionSlug, rows, ...(note ? { note } : {}) },
      { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } }
    )
  } catch (err) {
    console.log("[wallet-sales-history] error:", err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: err instanceof Error ? err.message : "Internal error" }, { status: 500 })
  }
}
