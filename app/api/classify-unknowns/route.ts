import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// GET /api/classify-unknowns
//
// Works through the 1,378 moment_acquisitions rows where Flowty had no
// purchase record (acquisition_confidence='checked_no_flowty'). For each,
// ask Top Shot GQL for lastPurchasePrice:
//   > 0  → TS marketplace purchase
//   = 0  → no TS marketplace sale and no Flowty record → pack pull (inferred)
//
// Designed to be called repeatedly (cron or manual) until the backlog clears.

const INGEST_TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const TS_GQL = process.env.TS_PROXY_URL || "https://public-api.nbatopshot.com/graphql"
const TS_PROXY_SECRET = process.env.TS_PROXY_SECRET || ""
const BATCH_SIZE = 50
const TREVOR_WALLET = "0xbd94cade097e50ac"
const TS_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

const GET_MINTED_MOMENT = `
  query GetMintedMoment($momentId: ID!) {
    getMintedMoment(momentId: $momentId) {
      data { flowId lastPurchasePrice createdAt }
    }
  }
`

async function fetchMoment(momentId: string): Promise<{ price: number | null; createdAt: string | null } | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (TS_PROXY_SECRET) headers["x-proxy-secret"] = TS_PROXY_SECRET
  try {
    const res = await fetch(TS_GQL, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: GET_MINTED_MOMENT, variables: { momentId } }),
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) return null
    const json = await res.json()
    const d = json?.data?.getMintedMoment?.data
    if (!d) return null
    return {
      price: d.lastPurchasePrice != null ? Number(d.lastPurchasePrice) : null,
      createdAt: d.createdAt ?? null,
    }
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (!INGEST_TOKEN || (bearer !== INGEST_TOKEN && urlToken !== INGEST_TOKEN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const wallet = (req.nextUrl.searchParams.get("wallet") ?? TREVOR_WALLET).toLowerCase()
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") ?? String(BATCH_SIZE), 10) || BATCH_SIZE, 200)

  const { data: batch, error } = await (supabaseAdmin as any)
    .from("moment_acquisitions")
    .select("id, nft_id")
    .eq("wallet", wallet)
    .eq("acquisition_method", "unknown")
    .eq("acquisition_confidence", "checked_no_flowty")
    .eq("collection_id", TS_COLLECTION_ID)
    .limit(limit)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!batch || batch.length === 0) {
    return NextResponse.json({ processed: 0, marketplace: 0, pack_pull: 0, unchanged: 0, remaining: 0 })
  }

  let marketplace = 0
  let pack_pull = 0
  let unchanged = 0

  for (const row of batch as Array<{ id: string; nft_id: string }>) {
    const gql = await fetchMoment(row.nft_id)
    if (!gql) {
      unchanged++
      continue
    }

    const isMarketplace = gql.price !== null && gql.price > 0
    const update: Record<string, unknown> = isMarketplace
      ? {
          acquisition_method: "marketplace",
          acquisition_confidence: "flow_scan",
          buy_price: gql.price,
          source: "topshot",
          ...(gql.createdAt ? { acquired_date: gql.createdAt } : {}),
        }
      : {
          acquisition_method: "pack_pull",
          acquisition_confidence: "inferred_no_sale",
          buy_price: 0,
          source: "pack",
          ...(gql.createdAt ? { acquired_date: gql.createdAt } : {}),
        }

    const { error: upErr } = await (supabaseAdmin as any)
      .from("moment_acquisitions")
      .update(update)
      .eq("id", row.id)

    if (upErr) {
      unchanged++
      continue
    }
    if (isMarketplace) marketplace++
    else pack_pull++
  }

  const { count: remaining } = await (supabaseAdmin as any)
    .from("moment_acquisitions")
    .select("*", { count: "exact", head: true })
    .eq("wallet", wallet)
    .eq("acquisition_method", "unknown")
    .eq("acquisition_confidence", "checked_no_flowty")
    .eq("collection_id", TS_COLLECTION_ID)

  return NextResponse.json({
    processed: batch.length,
    marketplace,
    pack_pull,
    unchanged,
    remaining: remaining ?? null,
  })
}
