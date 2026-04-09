import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import fcl from "@/lib/flow"
import * as t from "@onflow/types"

// POST /api/cost-basis-gql-backfill
// Body: { wallet, offset?, limit? }
// Auth: Bearer INGEST_SECRET_TOKEN
//
// Resumable cost-basis backfill that pulls lastPurchasePrice for every owned
// moment directly from Top Shot GQL. The /api/cost-basis-backfill route only
// matches against our local sales table (recent ingestion only); this route
// recovers full purchase history for all 14k+ moments by paging through
// getMintedMoment one chunk at a time.
//
// Response:
//   { done, total, offset, limit, processed, skippedExisting, inserted,
//     noPrice, gqlErrors, nextOffset, remaining }
// Caller loops while done === false.

const INGEST_TOKEN = process.env.INGEST_SECRET_TOKEN
const TS_GQL = process.env.TS_PROXY_URL || "https://public-api.nbatopshot.com/graphql"
const TS_PROXY_SECRET = process.env.TS_PROXY_SECRET || ""

const GET_MINTED_MOMENT = `
  query GetMintedMoment($momentId: ID!) {
    getMintedMoment(momentId: $momentId) {
      data {
        flowSerialNumber
        price
        lastPurchasePrice
        forSale
        createdAt
        play { stats { playerName } }
        set { flowName flowSeriesNumber }
        setPlay { circulationCount }
      }
    }
  }
`

interface MomentData {
  lastPurchasePrice: number | null
  createdAt: string | null
  playerName: string | null
}

async function fetchMomentData(flowId: string): Promise<MomentData | null> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (TS_PROXY_SECRET) headers["x-proxy-secret"] = TS_PROXY_SECRET

    const res = await fetch(TS_GQL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: GET_MINTED_MOMENT,
        variables: { momentId: flowId },
      }),
      signal: AbortSignal.timeout(8000),
    })

    if (!res.ok) return null
    const json = await res.json()
    const data = json?.data?.getMintedMoment?.data
    if (!data) return null

    return {
      lastPurchasePrice:
        data.lastPurchasePrice != null ? Number(data.lastPurchasePrice) : null,
      createdAt: data.createdAt ?? null,
      playerName: data.play?.stats?.playerName ?? null,
    }
  } catch {
    return null
  }
}

// In-memory cache for owned IDs across pagination calls within one warm
// instance. The Cadence query is the slow part of any single invocation, and
// the caller will hit this endpoint dozens of times in a row.
let cachedOwnedIds: { wallet: string; ids: string[]; at: number } | null = null

async function getOwnedIds(wallet: string): Promise<string[]> {
  if (
    cachedOwnedIds &&
    cachedOwnedIds.wallet === wallet &&
    Date.now() - cachedOwnedIds.at < 600_000
  ) {
    return cachedOwnedIds.ids
  }

  const cadence = `
    import TopShot from 0x0b2a3299cc857e29
    access(all) fun main(address: Address): [UInt64] {
      let acct = getAccount(address)
      let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
      if col == nil { return [] }
      return col!.getIDs()
    }
  `

  const result = await fcl.query({
    cadence,
    args: (arg: any) => [arg(wallet, t.Address)],
  })
  const ids = Array.isArray(result) ? result.map((id: unknown) => String(id)) : []
  cachedOwnedIds = { wallet, ids, at: Date.now() }
  return ids
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (!INGEST_TOKEN || auth !== "Bearer " + INGEST_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    wallet?: string
    offset?: number | string
    limit?: number | string
  }

  const rawWallet = String(body.wallet ?? "").trim()
  const hex = rawWallet.replace(/^0x/, "")
  if (!/^[a-fA-F0-9]{16}$/.test(hex)) {
    return NextResponse.json({ error: "wallet required (16-char hex)" }, { status: 400 })
  }
  const fullWallet = "0x" + hex

  const offset = Math.max(0, parseInt(String(body.offset ?? "0"), 10) || 0)
  const limit = Math.min(Math.max(1, parseInt(String(body.limit ?? "50"), 10) || 50), 200)

  let allIds: string[]
  try {
    allIds = await getOwnedIds(fullWallet)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: "Failed to fetch owned IDs", detail: msg }, { status: 500 })
  }

  const total = allIds.length
  const chunk = allIds.slice(offset, offset + limit)

  if (chunk.length === 0) {
    return NextResponse.json({
      done: true,
      total,
      offset,
      limit,
      processed: 0,
      skippedExisting: 0,
      inserted: 0,
      noPrice: 0,
      gqlErrors: 0,
      nextOffset: null,
      remaining: 0,
      message: "No more IDs to process",
    })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Skip IDs already covered (any source) so re-runs are cheap
  const { data: existingRows } = await (supabase as any)
    .from("moment_acquisitions")
    .select("nft_id")
    .eq("wallet", fullWallet)
    .in("nft_id", chunk)

  const existingIds = new Set((existingRows ?? []).map((r: { nft_id: string }) => r.nft_id))
  const toProcess = chunk.filter((id) => !existingIds.has(id))
  const skippedExisting = chunk.length - toProcess.length

  const PARALLEL = 5
  let noPrice = 0
  let gqlErrors = 0
  const acquisitionRows: Array<Record<string, unknown>> = []

  for (let i = 0; i < toProcess.length; i += PARALLEL) {
    const batch = toProcess.slice(i, i + PARALLEL)
    const results = await Promise.allSettled(batch.map((id) => fetchMomentData(id)))

    for (let j = 0; j < batch.length; j++) {
      const result = results[j]
      const flowId = batch[j]

      if (result.status !== "fulfilled" || !result.value) {
        gqlErrors++
        continue
      }

      const data = result.value
      if (!data.lastPurchasePrice || data.lastPurchasePrice <= 0) {
        noPrice++
        continue
      }

      acquisitionRows.push({
        nft_id: flowId,
        wallet: fullWallet,
        buy_price: data.lastPurchasePrice,
        acquired_date: data.createdAt || new Date().toISOString(),
        acquired_type: 1,
        fmv_at_acquisition: null,
        seller_address: null,
        transaction_hash: "gql:" + flowId,
        source: "gql_backfill",
      })
    }

    // Be nice to the upstream — small delay between parallel batches
    if (i + PARALLEL < toProcess.length) {
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  let inserted = 0
  if (acquisitionRows.length > 0) {
    const { error: insertErr } = await (supabase as any)
      .from("moment_acquisitions")
      .upsert(acquisitionRows, {
        onConflict: "nft_id,wallet,transaction_hash",
        ignoreDuplicates: true,
      })

    if (insertErr) {
      console.log("[cost-basis-gql] Insert error:", insertErr.message)
    } else {
      inserted = acquisitionRows.length
    }
  }

  const nextOffset = offset + limit
  const remaining = Math.max(0, total - nextOffset)
  const done = nextOffset >= total

  return NextResponse.json({
    done,
    total,
    offset,
    limit,
    processed: chunk.length,
    skippedExisting,
    inserted,
    noPrice,
    gqlErrors,
    nextOffset: done ? null : nextOffset,
    remaining,
  })
}
