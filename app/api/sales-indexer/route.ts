import { NextRequest, NextResponse } from "next/server"
import fcl from "@/lib/flow"
import { supabaseAdmin } from "@/lib/supabase"
import crypto from "crypto"

// ── Auth ──────────────────────────────────────────────────────────────────────

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const DAPPER_MERCHANT = "0xc1e4f4f4c4257510"
const EVENT_TYPE = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted"
const CHUNK_SIZE = 250
const MAX_BLOCKS_PER_RUN = 5000
const INTER_CHUNK_DELAY_MS = 100

// ── Helpers ───────────────────────────────────────────────────────────────────

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isTopShotNft(nftType: string): boolean {
  return typeof nftType === "string" && nftType.includes("TopShot")
}

function determineMarketplace(commissionReceiver: string | null): string {
  if (!commissionReceiver || commissionReceiver === DAPPER_MERCHANT) return "topshot"
  // Known Flowty addresses
  if (commissionReceiver.includes("flowty")) return "flowty"
  return "other"
}

function toIsoTimestamp(ts: string | number | Date): string {
  if (typeof ts === "string") {
    // FCL returns ISO strings or epoch-like strings
    const d = new Date(ts)
    if (!isNaN(d.getTime())) return d.toISOString()
  }
  if (typeof ts === "number") {
    // Could be seconds or milliseconds
    const d = new Date(ts > 1e12 ? ts : ts * 1000)
    if (!isNaN(d.getTime())) return d.toISOString()
  }
  return new Date().toISOString()
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const start = Date.now()

  // Auth check
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  if (!TOKEN || bearer !== TOKEN) return unauthorized()

  try {
    // Step 1: Read cursor
    const { data: cursorRow, error: cursorErr } = await (supabaseAdmin as any)
      .from("event_cursor")
      .select("last_processed_block")
      .eq("id", "topshot_sales")
      .single()

    if (cursorErr) {
      console.log("[sales-indexer] cursor read error:", cursorErr.message)
      return NextResponse.json({ error: "Failed to read cursor" }, { status: 500 })
    }

    let lastBlock = Number(cursorRow?.last_processed_block ?? 0)

    // Step 2: Get current sealed block height
    const latestBlock = await fcl.send([fcl.getBlock(true)]).then(fcl.decode)
    const currentHeight = Number(latestBlock.height)

    // If first run (cursor = 0), start 1000 blocks back
    if (lastBlock === 0) {
      lastBlock = currentHeight - 1000
      console.log("[sales-indexer] first run, starting from block", lastBlock)
    }

    // Cap blocks per run
    const targetHeight = Math.min(lastBlock + MAX_BLOCKS_PER_RUN, currentHeight)

    if (lastBlock >= currentHeight) {
      return NextResponse.json({
        ok: true,
        blocksScanned: 0,
        eventsFound: 0,
        salesResolved: 0,
        salesInserted: 0,
        salesDuped: 0,
        unresolved: [],
        cursor: lastBlock,
        elapsed: Date.now() - start,
        message: "Already up to date",
      })
    }

    console.log(`[sales-indexer] scanning blocks ${lastBlock + 1} → ${targetHeight} (${targetHeight - lastBlock} blocks)`)

    // Step 3: Scan for events in chunks
    interface SaleEvent {
      blockHeight: number
      blockTimestamp: string
      transactionId: string
      data: {
        listingResourceID: string
        storefrontResourceID: string
        purchased: boolean
        nftType: string
        nftUUID: string
        nftID: string
        salePaymentVaultType: string
        salePrice: string
        customID: string | null
        commissionAmount: string
        commissionReceiver: string | null
        expiry: string
      }
    }

    const matchingEvents: SaleEvent[] = []

    for (let startH = lastBlock + 1; startH <= targetHeight; startH += CHUNK_SIZE) {
      const endH = Math.min(startH + CHUNK_SIZE - 1, targetHeight)

      try {
        const events = await fcl.send([
          fcl.getEventsAtBlockHeightRange(EVENT_TYPE, startH, endH),
        ]).then(fcl.decode)

        if (Array.isArray(events)) {
          for (const evt of events) {
            const d = evt.data ?? evt
            if (d.purchased === true && isTopShotNft(d.nftType ?? "")) {
              matchingEvents.push({
                blockHeight: evt.blockHeight ?? startH,
                blockTimestamp: evt.blockTimestamp ?? new Date().toISOString(),
                transactionId: evt.transactionId ?? null,
                data: d,
              })
            }
          }
        }
      } catch (err) {
        console.log(`[sales-indexer] chunk ${startH}-${endH} error:`, err instanceof Error ? err.message : String(err))
        // Continue with next chunk
      }

      if (startH + CHUNK_SIZE <= targetHeight) {
        await delay(INTER_CHUNK_DELAY_MS)
      }
    }

    console.log(`[sales-indexer] found ${matchingEvents.length} TopShot sale events`)

    if (matchingEvents.length === 0) {
      // Update cursor even if no events
      await (supabaseAdmin as any)
        .from("event_cursor")
        .update({ last_processed_block: targetHeight, updated_at: new Date().toISOString() })
        .eq("id", "topshot_sales")

      return NextResponse.json({
        ok: true,
        blocksScanned: targetHeight - lastBlock,
        eventsFound: 0,
        salesResolved: 0,
        salesInserted: 0,
        salesDuped: 0,
        unresolved: [],
        cursor: targetHeight,
        elapsed: Date.now() - start,
      })
    }

    // Step 4: Resolve nftID to edition
    const nftIds = matchingEvents.map((e) => String(e.data.nftID))
    const uniqueNftIds = [...new Set(nftIds)]

    // 4a: Check wallet_moments_cache
    const cacheMap = new Map<string, { edition_key: string; serial_number: number | null }>()
    for (let i = 0; i < uniqueNftIds.length; i += 500) {
      const batch = uniqueNftIds.slice(i, i + 500)
      const { data: cacheRows } = await (supabaseAdmin as any)
        .from("wallet_moments_cache")
        .select("moment_id, edition_key, serial_number")
        .in("moment_id", batch)

      if (cacheRows) {
        for (const row of cacheRows) {
          if (row.edition_key) {
            cacheMap.set(row.moment_id, {
              edition_key: row.edition_key,
              serial_number: row.serial_number ?? null,
            })
          }
        }
      }
    }

    // 4b: Remaining — check moments table
    const remaining = uniqueNftIds.filter((id) => !cacheMap.has(id))
    const momentsMap = new Map<string, string>() // nft_id → edition_id
    if (remaining.length > 0) {
      for (let i = 0; i < remaining.length; i += 500) {
        const batch = remaining.slice(i, i + 500)
        const { data: momentRows } = await (supabaseAdmin as any)
          .from("moments")
          .select("nft_id, edition_id")
          .in("nft_id", batch)

        if (momentRows) {
          for (const row of momentRows) {
            if (row.edition_id) momentsMap.set(row.nft_id, row.edition_id)
          }
        }
      }
    }

    // 4c: Resolve edition_keys to edition UUIDs
    const editionKeys = [...new Set([...cacheMap.values()].map((v) => v.edition_key))]
    const editionKeyToId = new Map<string, string>()
    if (editionKeys.length > 0) {
      for (let i = 0; i < editionKeys.length; i += 500) {
        const batch = editionKeys.slice(i, i + 500)
        const { data: edRows } = await (supabaseAdmin as any)
          .from("editions")
          .select("id, external_id")
          .in("external_id", batch)
          .eq("collection_id", TOPSHOT_COLLECTION_ID)

        if (edRows) {
          for (const row of edRows) {
            editionKeyToId.set(row.external_id, row.id)
          }
        }
      }
    }

    // Step 5 & 6: Build and insert sales
    const salesBatch: any[] = []
    const unresolvedIds: string[] = []

    for (const evt of matchingEvents) {
      const nftId = String(evt.data.nftID)
      let editionId: string | null = null
      let serialNumber = 0

      const cached = cacheMap.get(nftId)
      if (cached) {
        editionId = editionKeyToId.get(cached.edition_key) ?? null
        serialNumber = cached.serial_number ?? 0
      } else {
        editionId = momentsMap.get(nftId) ?? null
      }

      if (!editionId) {
        unresolvedIds.push(nftId)
        continue
      }

      const marketplace = determineMarketplace(evt.data.commissionReceiver)

      salesBatch.push({
        id: crypto.randomUUID(),
        edition_id: editionId,
        collection_id: TOPSHOT_COLLECTION_ID,
        collection: "nba_top_shot",
        nft_id: nftId,
        price_usd: parseFloat(evt.data.salePrice) || 0,
        serial_number: serialNumber,
        sold_at: toIsoTimestamp(evt.blockTimestamp),
        marketplace,
        source: "onchain",
        block_height: evt.blockHeight,
        transaction_hash: evt.transactionId ?? null,
        buyer_address: null,
        seller_address: null,
        ingested_at: new Date().toISOString(),
      })
    }

    console.log(`[sales-indexer] resolved ${salesBatch.length} sales, ${unresolvedIds.length} unresolved`)

    // Insert in batches of 100
    let inserted = 0
    let duped = 0

    for (let i = 0; i < salesBatch.length; i += 100) {
      const batch = salesBatch.slice(i, i + 100)
      try {
        const { data: insertResult, error: insertErr } = await (supabaseAdmin as any)
          .from("sales")
          .insert(batch)

        if (insertErr) {
          // Unique constraint violation — some dupes
          if (insertErr.code === "23505") {
            duped += batch.length
          } else {
            console.log("[sales-indexer] batch insert error:", insertErr.message)
            duped += batch.length
          }
        } else {
          inserted += batch.length
        }
      } catch (err) {
        console.log("[sales-indexer] insert exception:", err instanceof Error ? err.message : String(err))
        // Try individual inserts for partial success
        for (const sale of batch) {
          try {
            const { error: singleErr } = await (supabaseAdmin as any)
              .from("sales")
              .insert(sale)
            if (singleErr) {
              duped++
            } else {
              inserted++
            }
          } catch {
            duped++
          }
        }
      }
    }

    // Step 7: Update cursor
    await (supabaseAdmin as any)
      .from("event_cursor")
      .update({ last_processed_block: targetHeight, updated_at: new Date().toISOString() })
      .eq("id", "topshot_sales")

    // Step 8: Return summary
    return NextResponse.json({
      ok: true,
      blocksScanned: targetHeight - lastBlock,
      eventsFound: matchingEvents.length,
      salesResolved: salesBatch.length,
      salesInserted: inserted,
      salesDuped: duped,
      unresolved: unresolvedIds.slice(0, 50),
      cursor: targetHeight,
      elapsed: Date.now() - start,
    })
  } catch (err) {
    console.log("[sales-indexer] fatal error:", err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: "Internal server error", details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
