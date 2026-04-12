// app/api/pinnacle-ingest/route.ts
// GET /api/pinnacle-ingest?token=<INGEST_SECRET_TOKEN>
// Fetches all Pinnacle NFTs from Flowty in batches, upserts editions,
// indexes sales, and triggers FMV recalc.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import {
  fetchAllFlowtyPinnacleNfts,
  extractEditionKeyFromNft,
  type FlowtyPinnacleNft,
} from "@/lib/pinnacle/pinnacleFlowty"
import {
  parseStringifiedArray,
  flowtyTraitsToPinnacleEdition,
} from "@/lib/pinnacle/pinnacleTypes"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const INGEST_SECRET = process.env.INGEST_SECRET_TOKEN ?? ""

export async function GET(req: NextRequest) {
  // Auth check
  const url = new URL(req.url)
  const token = url.searchParams.get("token") ?? req.headers.get("x-ingest-token") ?? ""
  if (!INGEST_SECRET || token !== INGEST_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startTime = Date.now()
  const log: string[] = []

  try {
    // Step 1: Fetch all NFTs from Flowty
    log.push("Fetching Pinnacle NFTs from Flowty...")
    const allNfts = await fetchAllFlowtyPinnacleNfts({
      batchSize: 24,
      maxTotal: 12000,
      timeoutMs: 12000,
    })
    log.push(`Fetched ${allNfts.length} NFTs from Flowty`)

    // Step 2: Upsert editions
    let editionsUpserted = 0
    let editionErrors = 0
    const seenEditions = new Set<string>()

    for (const nft of allNfts) {
      const traits = nft.nftView?.traits?.traits ?? []
      const editionData = flowtyTraitsToPinnacleEdition(traits)
      if (!editionData.editionKey || !editionData.royaltyCode) continue
      if (seenEditions.has(editionData.editionKey)) continue
      seenEditions.add(editionData.editionKey)

      const mintCount = nft.card.max ? parseInt(nft.card.max, 10) : null

      const { error } = await (supabaseAdmin as any).rpc("upsert_pinnacle_edition", {
        p_edition_key: editionData.editionKey,
        p_character_name: editionData.characterName ?? "Unknown",
        p_franchise: editionData.franchise ?? "Unknown",
        p_studio: editionData.studio ?? "Unknown",
        p_set_name: editionData.setName ?? "",
        p_royalty_code: editionData.royaltyCode,
        p_series_year: editionData.seriesYear ?? null,
        p_variant_type: editionData.variantType ?? "Standard",
        p_edition_type: editionData.editionType ?? "Open Edition",
        p_printing: editionData.printing ?? 1,
        p_mint_count: mintCount,
        p_is_serialized: editionData.isSerialized ?? false,
        p_is_chaser: editionData.isChaser ?? false,
        p_materials: editionData.materials ?? [],
        p_effects: editionData.effects ?? [],
        p_size: editionData.size ?? null,
        p_color: editionData.color ?? null,
        p_thickness: editionData.thickness ?? null,
        p_minting_date: editionData.mintingDate ?? null,
        p_thumbnail_url: nft.card.images?.[0]?.url ?? null,
      })

      if (error) {
        editionErrors++
        if (editionErrors <= 3) {
          log.push(`Edition upsert error for ${editionData.editionKey}: ${error.message}`)
        }
      } else {
        editionsUpserted++
      }
    }
    log.push(`Editions: ${editionsUpserted} upserted, ${editionErrors} errors, ${seenEditions.size} unique`)

    // Step 3: Index sales from completed orders
    // Flowty NFTs with orders where state !== "LISTED" are completed sales
    const salesRows: Array<Record<string, unknown>> = []

    for (const nft of allNfts) {
      const { editionKey } = extractEditionKeyFromNft(nft)
      if (!editionKey) continue

      for (const order of nft.orders ?? []) {
        // Only process completed sales (not active listings)
        if (order.state === "LISTED") continue
        if (!order.salePrice || order.salePrice <= 0) continue

        const blockTs = order.blockTimestamp
        const ms = blockTs && blockTs > 0 ? (blockTs < 1e12 ? blockTs * 1000 : blockTs) : null

        salesRows.push({
          edition_key: editionKey,
          sale_price: order.salePrice,
          transaction_hash: order.transactionId ?? null,
          sold_at: ms ? new Date(ms).toISOString() : new Date().toISOString(),
          source: "flowty",
          buyer_address: null,
          seller_address: order.storefrontAddress ?? null,
        })
      }
    }

    let salesInserted = 0
    if (salesRows.length > 0) {
      // Batch insert via RPC
      const { data, error } = await (supabaseAdmin as any).rpc("bulk_insert_pinnacle_sales", {
        sales_json: JSON.stringify(salesRows),
      })
      if (error) {
        log.push(`Sales insert error: ${error.message}`)
      } else {
        salesInserted = typeof data === "number" ? data : salesRows.length
        log.push(`Sales: ${salesInserted} inserted from ${salesRows.length} candidates`)
      }
    } else {
      log.push("No completed sales found in Flowty response")
    }

    // Step 4: Trigger FMV recalc
    log.push("Triggering FMV recalc...")
    const { error: fmvError } = await (supabaseAdmin as any).rpc("pinnacle_fmv_recalc_all")
    if (fmvError) {
      log.push(`FMV recalc error: ${fmvError.message}`)
    } else {
      log.push("FMV recalc complete")
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    log.push(`Total elapsed: ${elapsed}s`)

    return NextResponse.json({
      ok: true,
      nftsFromFlowty: allNfts.length,
      editionsUpserted,
      editionErrors,
      salesInserted,
      elapsed: `${elapsed}s`,
      log,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.push(`Fatal error: ${msg}`)
    return NextResponse.json(
      { ok: false, error: msg, log },
      { status: 500 }
    )
  }
}
