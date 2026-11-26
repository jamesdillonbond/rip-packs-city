// app/api/ufc/moment-chain/route.ts
//
// GET ?edition=<editions.id>&serial=<n> → where ONE UFC Strike Moment lives now (2026-11-26, Trevor: "we
// give them a Flow or Aptos tag to identify where that asset lives").
//
// Migrating burned the Flow Moment and minted the same edition + serial on Aptos (serials survived the
// burn-and-mint), so the Aptos indexer is authoritative for whether a given serial exists on Aptos:
//   - found         → { chain: "aptos", token_data_id, rarible_url, explorer_url, held_by_ufc }
//   - not found     → { chain: "flow" }   (the edition IS mapped to Aptos and that serial was never minted there)
//   - edition not mapped to any Aptos collection → { chain: null }   (cannot say — never "flow")
//   - a failed read → 5xx                                              (never a chain claim)
// The Aptos owner is NOT returned: on a Flow Moment's page it would publish the Flow→Aptos owner link that
// RPC keeps internal (claude/ufc-reopen-on-aptos-plan-2026-11-16.md). `held_by_ufc` names only UFC's own
// wallets (the store / issuer), which is what tells a collector the Moment is buyable from UFC.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { UFC_APTOS_KNOWN_WALLETS, raribleAptosCollectionUrl } from "@/lib/ufc-aptos"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const APTOS_INDEXER = "https://api.mainnet.aptoslabs.com/v1/graphql"
const Q = `query($c:[String!],$p:jsonb){current_token_ownerships_v2(where:{amount:{_gt:"0"},current_token_data:{collection_id:{_in:$c},token_properties:{_contains:$p}}},limit:2){owner_address token_data_id current_token_data{collection_id}}}`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest) {
  const edition = req.nextUrl.searchParams.get("edition") ?? ""
  const serial = Number(req.nextUrl.searchParams.get("serial"))
  if (!UUID.test(edition) || !Number.isInteger(serial) || serial <= 0) {
    return NextResponse.json({ error: "edition (uuid) and serial (positive integer) are required" }, { status: 400 })
  }
  try {
    const { data, error } = await boundedRead(
      supabaseAdmin.from("ufc_aptos_collections").select("aptos_collection_id").eq("edition_id", edition).order("aptos_collection_id"),
      "api/ufc/moment-chain/ufc_aptos_collections",
    )
    if (error) return apiErrorResponse(error, "api/ufc/moment-chain", "Couldn't check where this Moment lives.")
    const collections = ((data ?? []) as Array<{ aptos_collection_id: string | null }>).map((r) => r.aptos_collection_id).filter((x): x is string => !!x)
    if (collections.length === 0) return NextResponse.json({ chain: null }, { headers: { "Cache-Control": "public, s-maxage=300" } })

    const key = process.env.APTOS_API_KEY
    const res = await fetch(APTOS_INDEXER, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ query: Q, variables: { c: collections, p: { "Serial Number": String(serial) } } }),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    })
    if (!res.ok) throw new Error(`aptos indexer ${res.status}`)
    const j = (await res.json()) as { data?: { current_token_ownerships_v2?: Array<{ owner_address: string; token_data_id: string; current_token_data?: { collection_id?: string } }> }; errors?: unknown }
    const rows = j.data?.current_token_ownerships_v2
    if (j.errors || !rows) throw new Error("aptos indexer error")
    if (rows.length === 0) return NextResponse.json({ chain: "flow" }, { headers: { "Cache-Control": "public, s-maxage=300" } })
    const t = rows[0]
    const owner = (t.owner_address ?? "").toLowerCase()
    return NextResponse.json(
      {
        chain: "aptos",
        token_data_id: t.token_data_id,
        rarible_url: raribleAptosCollectionUrl(t.current_token_data?.collection_id ?? collections[0]),
        explorer_url: `https://explorer.aptoslabs.com/token/${t.token_data_id}?network=mainnet`,
        held_by_ufc: Object.prototype.hasOwnProperty.call(UFC_APTOS_KNOWN_WALLETS, owner) ? UFC_APTOS_KNOWN_WALLETS[owner] : null,
      },
      { headers: { "Cache-Control": "public, s-maxage=300" } },
    )
  } catch (err) {
    return apiErrorResponse(err, "api/ufc/moment-chain", "Couldn't check where this Moment lives.")
  }
}
