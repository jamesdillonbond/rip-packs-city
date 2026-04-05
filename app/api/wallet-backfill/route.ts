import { NextRequest, NextResponse } from "next/server"
import fcl from "@/lib/flow"
import * as t from "@onflow/types"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const BATCH_SIZE = 20
const CONCURRENCY = 8
const UPSERT_CHUNK = 200

async function getOwnedMomentIds(wallet: string): Promise<number[]> {
  const cadence = `
    import TopShot from 0x0b2a3299cc857e29
    access(all)
    fun main(address: Address): [UInt64] {
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
  return Array.isArray(result) ? (result as number[]) : []
}

async function getMomentMetadata(wallet: string, id: number): Promise<Record<string, string>> {
  const cadence = `
    import TopShot from 0x0b2a3299cc857e29
    import MetadataViews from 0x1d7e57aa55817448
    access(all)
    fun main(address: Address, id: UInt64): {String:String} {
      let acct = getAccount(address)
      let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
        ?? panic("no collection")
      let nft = col.borrowMoment(id:id) ?? panic("no nft")
      let view = nft.resolveView(Type<TopShot.TopShotMomentMetadataView>()) ?? panic("no metadata")
      let data = view as! TopShot.TopShotMomentMetadataView
      return {
        "player": data.fullName ?? "",
        "team": data.teamAtMoment ?? "",
        "setName": data.setName ?? "",
        "series": data.seriesNumber?.toString() ?? "",
        "serial": data.serialNumber.toString(),
        "mint": data.numMomentsInEdition?.toString() ?? "",
        "playID": data.playID.toString(),
        "setID": data.setID.toString()
      }
    }
  `
  const result = await fcl.query({
    cadence,
    args: (arg: any) => [arg(wallet, t.Address), arg(String(id), t.UInt64)],
  })
  return result as Record<string, string>
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex++
      if (currentIndex >= items.length) return
      results[currentIndex] = await worker(items[currentIndex], currentIndex)
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => runWorker())
  )
  return results
}

export async function POST(req: NextRequest) {
  // Auth check
  const authHeader = req.headers.get("authorization")
  const expectedToken = process.env.INGEST_SECRET_TOKEN
  if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: { wallet?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const wallet = body.wallet?.trim()
  if (!wallet) {
    return NextResponse.json({ error: "wallet field required" }, { status: 400 })
  }

  console.log(`[wallet-backfill] Starting backfill for wallet: ${wallet}`)

  const now = new Date().toISOString()
  let totalFetched = 0
  let totalUpserted = 0
  let batchesFetched = 0

  try {
    // Step 1: Get all owned moment IDs via FCL on-chain query
    const ids = await getOwnedMomentIds(wallet)
    console.log(`[wallet-backfill] Found ${ids.length} moment IDs on-chain for ${wallet}`)

    if (ids.length === 0) {
      return NextResponse.json({
        total_fetched: 0,
        total_upserted: 0,
        pages_fetched: 0,
        wallet_address: wallet,
      })
    }

    // Step 2 & 3: Process in batches of 20 with concurrency 8
    const allRows: Array<{
      wallet_address: string
      moment_id: string
      edition_key: string
      serial_number: number | null
      fmv_usd: null
      last_seen_at: string
    }> = []

    for (let batchStart = 0; batchStart < ids.length; batchStart += BATCH_SIZE) {
      const batch = ids.slice(batchStart, batchStart + BATCH_SIZE)
      batchesFetched++

      const metadataResults = await mapWithConcurrency(batch, CONCURRENCY, async (id) => {
        try {
          return await getMomentMetadata(wallet, id)
        } catch (err) {
          console.warn(
            `[wallet-backfill] Failed to fetch metadata for moment ${id}:`,
            err instanceof Error ? err.message : String(err)
          )
          return null
        }
      })

      for (let i = 0; i < batch.length; i++) {
        const meta = metadataResults[i]
        if (!meta) continue

        totalFetched++

        const setID = meta.setID ?? null
        const playID = meta.playID ?? null
        const editionKey = setID && playID ? `${setID}:${playID}` : ""
        const serial = meta.serial ? parseInt(meta.serial, 10) : null

        allRows.push({
          wallet_address: wallet,
          moment_id: String(batch[i]),
          edition_key: editionKey,
          serial_number: Number.isFinite(serial) ? serial : null,
          fmv_usd: null,
          last_seen_at: now,
        })
      }

      // Log progress every 100 moments
      if (totalFetched > 0 && totalFetched % 100 < BATCH_SIZE) {
        console.log(`[wallet-backfill] Progress: ${totalFetched} moments processed`)
      }
    }

    // Step 4: Upsert in chunks of 200
    if (allRows.length > 0) {
      for (let i = 0; i < allRows.length; i += UPSERT_CHUNK) {
        const chunk = allRows.slice(i, i + UPSERT_CHUNK)
        const { data, error } = await (supabaseAdmin as any)
          .from("wallet_moments_cache")
          .upsert(chunk, { onConflict: "wallet_address,moment_id" })
          .select("moment_id")

        if (error) {
          console.error(
            `[wallet-backfill] Upsert error at chunk ${Math.floor(i / UPSERT_CHUNK)}:`,
            error.message
          )
        }
        totalUpserted += data?.length ?? chunk.length
      }
    }

    console.log(
      `[wallet-backfill] Backfill complete for ${wallet}: ${totalFetched} fetched, ${totalUpserted} upserted, ${batchesFetched} batches`
    )

    return NextResponse.json({
      total_fetched: totalFetched,
      total_upserted: totalUpserted,
      pages_fetched: batchesFetched,
      wallet_address: wallet,
    })
  } catch (err) {
    console.error(
      `[wallet-backfill] Error during backfill:`,
      err instanceof Error ? err.message : String(err)
    )
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : String(err),
        total_fetched: totalFetched,
        total_upserted: totalUpserted,
        pages_fetched: batchesFetched,
        wallet_address: wallet,
      },
      { status: 500 }
    )
  }
}
