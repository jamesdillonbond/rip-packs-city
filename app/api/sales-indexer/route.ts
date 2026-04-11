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
const STOREFRONT_EVENT = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted"
const TOPSHOT_MARKET_EVENT = "A.c1e4f4f4c4257510.TopShotMarketV3.MomentPurchased"
const CHUNK_SIZE = 250
const MAX_BLOCKS_PER_RUN = 5000
const INTER_CHUNK_DELAY_MS = 100

// ── Helpers ───────────────────────────────────────────────────────────────────

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isTopShotNft(nftType: unknown): boolean {
  if (typeof nftType === "string") return nftType.includes("TopShot")
  if (nftType && typeof nftType === "object") {
    const obj = nftType as Record<string, unknown>
    if (typeof obj.typeID === "string") return obj.typeID.includes("TopShot")
    if (typeof obj.value === "string") return obj.value.includes("TopShot")
  }
  return false
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
  const debugMode = req.nextUrl.searchParams.get("debug") === "true"

  console.log(`[sales-indexer] proxy config: url=${process.env.TS_PROXY_URL ? 'SET' : 'UNSET'} secret=${process.env.TS_PROXY_SECRET ? 'SET' : 'UNSET'}`)

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
      source: "storefrontV2" | "topshotMarketV3"
      data: {
        listingResourceID?: string
        storefrontResourceID?: string
        purchased?: boolean
        nftType?: unknown
        nftUUID?: string
        nftID: string
        salePaymentVaultType?: string
        salePrice: string
        customID?: string | null
        commissionAmount?: string
        commissionReceiver?: string | null
        expiry?: string
        id?: string
        price?: string
        seller?: string
      }
    }

    const matchingEvents: SaleEvent[] = []
    let rawEventLogCount = 0

    for (let startH = lastBlock + 1; startH <= targetHeight; startH += CHUNK_SIZE) {
      const endH = Math.min(startH + CHUNK_SIZE - 1, targetHeight)

      // Scan NFTStorefrontV2 events
      try {
        const events = await fcl.send([
          fcl.getEventsAtBlockHeightRange(STOREFRONT_EVENT, startH, endH),
        ]).then(fcl.decode)

        if (Array.isArray(events)) {
          // Debug: log first 5 raw storefront events before any filtering
          if (debugMode && rawEventLogCount < 5) {
            for (const evt of events.slice(0, 5 - rawEventLogCount)) {
              const d = evt.data ?? evt
              console.log(`[sales-indexer][debug] raw StorefrontV2 event nftType type=${typeof d.nftType} value=${JSON.stringify(d.nftType)}`)
              console.log(`[sales-indexer][debug] raw StorefrontV2 event: ${JSON.stringify(evt)}`)
              rawEventLogCount++
            }
          }

          for (const evt of events) {
            const d = evt.data ?? evt
            if (d.purchased === true && isTopShotNft(d.nftType)) {
              matchingEvents.push({
                blockHeight: evt.blockHeight ?? startH,
                blockTimestamp: evt.blockTimestamp ?? new Date().toISOString(),
                transactionId: evt.transactionId ?? null,
                source: "storefrontV2",
                data: d,
              })
            }
          }
        }
      } catch (err) {
        console.log(`[sales-indexer] StorefrontV2 chunk ${startH}-${endH} error:`, err instanceof Error ? err.message : String(err))
      }

      // Scan TopShotMarketV3 events
      try {
        const marketEvents = await fcl.send([
          fcl.getEventsAtBlockHeightRange(TOPSHOT_MARKET_EVENT, startH, endH),
        ]).then(fcl.decode)

        if (Array.isArray(marketEvents)) {
          if (debugMode && rawEventLogCount < 5) {
            for (const evt of marketEvents.slice(0, 5 - rawEventLogCount)) {
              console.log(`[sales-indexer][debug] raw TopShotMarketV3 event: ${JSON.stringify(evt)}`)
              rawEventLogCount++
            }
          }

          for (const evt of marketEvents) {
            const d = evt.data ?? evt
            matchingEvents.push({
              blockHeight: evt.blockHeight ?? startH,
              blockTimestamp: evt.blockTimestamp ?? new Date().toISOString(),
              transactionId: evt.transactionId ?? null,
              source: "topshotMarketV3",
              data: {
                nftID: String(d.id ?? d.nftID),
                salePrice: String(d.price ?? d.salePrice ?? "0"),
                seller: d.seller ?? null,
              },
            })
          }
        }
      } catch (err) {
        console.log(`[sales-indexer] TopShotMarketV3 chunk ${startH}-${endH} error:`, err instanceof Error ? err.message : String(err))
      }

      if (startH + CHUNK_SIZE <= targetHeight) {
        await delay(INTER_CHUNK_DELAY_MS)
      }
    }

    console.log(`[sales-indexer] found ${matchingEvents.length} TopShot sale events (storefrontV2 + marketV3)`)

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

    // Step 4d: GQL fallback for unresolved nftIDs
    const stillUnresolved = uniqueNftIds.filter((id) => {
      if (cacheMap.has(id) && editionKeyToId.has(cacheMap.get(id)!.edition_key)) return false
      if (momentsMap.has(id)) return false
      return true
    })

    const GQL_MAX = 50
    const GQL_DELAY_MS = 200
    const gqlResolvedMap = new Map<string, string>() // nftID → edition UUID
    const proxyUrl = process.env.TS_PROXY_URL || "https://public-api.nbatopshot.com/graphql"

    if (stillUnresolved.length > 0) {
      console.log(`[sales-indexer] attempting GQL resolution for ${Math.min(stillUnresolved.length, GQL_MAX)} of ${stillUnresolved.length} unresolved nftIDs`)

      const gqlQuery = `query($id:ID!){getMintedMoment(momentId:$id){data{...on MintedMoment{play{...on Play{id}}set{...on Set{id flowSeriesNumber}}}}}}`

      // In-memory cache: nftID → edition UUID (avoids repeat GQL calls for same moment)
      const gqlEditionCache = new Map<string, string>()

      for (let i = 0; i < Math.min(stillUnresolved.length, GQL_MAX); i++) {
        const nftId = stillUnresolved[i]

        // Skip if already resolved by a prior GQL call in this run
        if (gqlEditionCache.has(nftId)) {
          gqlResolvedMap.set(nftId, gqlEditionCache.get(nftId)!)
          continue
        }

        try {
          console.log(`[sales-indexer] GQL attempting nftID=${nftId} url=${proxyUrl}`)
          const resp = await fetch(proxyUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(process.env.TS_PROXY_SECRET ? { "X-Proxy-Secret": process.env.TS_PROXY_SECRET } : {}),
            },
            body: JSON.stringify({
              query: gqlQuery,
              variables: { id: nftId },
            }),
          })

          console.log(`[sales-indexer] GQL response status=${resp.status}`)
          if (resp.ok) {
            const json = await resp.json()
            console.log(`[sales-indexer] GQL response body=${JSON.stringify(json).slice(0, 500)}`)
            const momentData = json?.data?.getMintedMoment?.data
            if (momentData) {
              const playId = momentData.play?.id
              const setId = momentData.set?.id

              if (playId && setId) {
                // Try UUID-based lookup: set_id + player_id columns
                const { data: edRow } = await (supabaseAdmin as any)
                  .from("editions")
                  .select("id, external_id")
                  .eq("collection_id", TOPSHOT_COLLECTION_ID)
                  .eq("set_id", setId)
                  .eq("player_id", playId)
                  .limit(1)
                  .maybeSingle()

                if (edRow?.id) {
                  gqlResolvedMap.set(nftId, edRow.id)
                  gqlEditionCache.set(nftId, edRow.id)
                } else {
                  // Fallback: try external_id if GQL returns integer-like IDs
                  const extKey = `${setId}:${playId}`
                  const { data: edRow2 } = await (supabaseAdmin as any)
                    .from("editions")
                    .select("id")
                    .eq("collection_id", TOPSHOT_COLLECTION_ID)
                    .eq("external_id", extKey)
                    .limit(1)
                    .maybeSingle()

                  if (edRow2?.id) {
                    gqlResolvedMap.set(nftId, edRow2.id)
                    gqlEditionCache.set(nftId, edRow2.id)
                  } else {
                    console.log(`[sales-indexer] GQL edition lookup failed for setId=${setId} playId=${playId}`)
                  }
                }
              }
            }
          } else {
            console.log(`[sales-indexer] GQL lookup failed for nftID=${nftId}: HTTP ${resp.status}`)
          }
        } catch (err) {
          console.log(`[sales-indexer] GQL lookup error for nftID=${nftId}:`, err instanceof Error ? err.message : String(err))
        }

        if (i < Math.min(stillUnresolved.length, GQL_MAX) - 1) {
          await delay(GQL_DELAY_MS)
        }
      }

      if (gqlResolvedMap.size > 0) {
        console.log(`[sales-indexer] GQL resolved ${gqlResolvedMap.size} additional editions`)
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

      // GQL fallback
      if (!editionId) {
        editionId = gqlResolvedMap.get(nftId) ?? null
      }

      if (!editionId) {
        unresolvedIds.push(nftId)
        continue
      }

      const marketplace = evt.source === "topshotMarketV3"
        ? "topshot"
        : determineMarketplace(evt.data.commissionReceiver ?? null)

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
        seller_address: evt.data.seller ?? null,
        ingested_at: new Date().toISOString(),
      })
    }

    console.log(`[sales-indexer] resolved ${salesBatch.length} sales (${gqlResolvedMap.size} via GQL), ${unresolvedIds.length} unresolved`)

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

    // ── Pipeline chain: fire-and-forget next step ──────────────────────────
    if (req.nextUrl.searchParams.get("chain") === "true") {
      const baseUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "https://rip-packs-city.vercel.app"
      const pipelineToken = process.env.INGEST_SECRET_TOKEN
      if (pipelineToken) {
        fetch(`${baseUrl}/api/fmv-recalc?chain=true`, {
          method: "POST",
          headers: { Authorization: `Bearer ${pipelineToken}` },
        }).catch(() => {})
      }
    }

    // Step 8: Return summary
    return NextResponse.json({
      ok: true,
      blocksScanned: targetHeight - lastBlock,
      eventsFound: matchingEvents.length,
      salesResolved: salesBatch.length,
      gqlResolved: gqlResolvedMap.size,
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
