import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import fcl from "@/lib/flow"
import * as t from "@onflow/types"

// POST /api/cost-basis-backfill
// Body: { wallet: "0x..." }
// Auth: Bearer INGEST_SECRET_TOKEN
//
// One-time backfill: derive moment_acquisitions rows for every NFT currently
// owned by the wallet by joining its on-chain Flow IDs against the sales table.
// The most recent sale of an nft_id is, by definition, the buy that placed it
// in the current owner's collection.

const INGEST_TOKEN = process.env.INGEST_SECRET_TOKEN

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (!INGEST_TOKEN || auth !== "Bearer " + INGEST_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  const rawWallet = String((body as { wallet?: string }).wallet ?? "").trim()
  const hex = rawWallet.replace(/^0x/, "")
  if (!/^[a-fA-F0-9]{16}$/.test(hex)) {
    return NextResponse.json({ error: "wallet required (16-char hex)" }, { status: 400 })
  }
  const fullWallet = "0x" + hex

  const cadence = `
    import TopShot from 0x0b2a3299cc857e29
    access(all) fun main(address: Address): [UInt64] {
      let acct = getAccount(address)
      let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
      if col == nil { return [] }
      return col!.getIDs()
    }
  `

  let ownedIds: string[]
  try {
    const result = await fcl.query({
      cadence,
      args: (arg: any) => [arg(fullWallet, t.Address)],
    })
    ownedIds = Array.isArray(result) ? result.map((id: unknown) => String(id)) : []
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      { error: "Failed to fetch owned IDs", detail: msg },
      { status: 500 }
    )
  }

  if (ownedIds.length === 0) {
    return NextResponse.json({
      result: { inserted: 0, skipped: 0, no_sale: 0, total_ids: 0 },
      message: "No owned moments found",
    })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const CHUNK = 500
  let totalInserted = 0
  let totalSkipped = 0
  let totalNoSale = 0
  const errors: string[] = []

  for (let i = 0; i < ownedIds.length; i += CHUNK) {
    const chunk = ownedIds.slice(i, i + CHUNK)
    const { data, error } = await (supabase as any).rpc("backfill_cost_basis_from_ids", {
      p_wallet: fullWallet,
      p_nft_ids: chunk,
    })
    if (error) {
      console.log("[cost-basis-backfill] RPC error:", error.message)
      errors.push(error.message)
      continue
    }
    const result = typeof data === "string" ? JSON.parse(data) : data
    totalInserted += result?.inserted ?? 0
    totalSkipped += result?.skipped ?? 0
    totalNoSale += result?.no_sale ?? 0
  }

  return NextResponse.json({
    wallet: fullWallet,
    result: {
      inserted: totalInserted,
      skipped: totalSkipped,
      no_sale: totalNoSale,
      total_ids: ownedIds.length,
    },
    errors: errors.length ? errors : undefined,
  })
}
