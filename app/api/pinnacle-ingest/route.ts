// app/api/pinnacle-ingest/route.ts
// POST /api/pinnacle-ingest?token=<INGEST_SECRET_TOKEN>&limit=100&offset=0[&recalc=true]
//   Fetches one batch of Pinnacle NFTs from Flowty, upserts editions + sales,
//   and returns the next offset so the caller can chain requests.
// GET  /api/pinnacle-ingest  → pinnacle_health_check (monitor progress, no auth)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import {
  fetchFlowtyPinnacleListings,
  extractEditionKeyFromNft,
} from "@/lib/pinnacle/pinnacleFlowty"
import { flowtyTraitsToPinnacleEdition } from "@/lib/pinnacle/pinnacleTypes"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const INGEST_SECRET = process.env.INGEST_SECRET_TOKEN ?? ""

export async function GET() {
  const { data, error } = await (supabaseAdmin as any).rpc("pinnacle_health_check")
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, health: data })
}

export async function POST(req: NextRequest) {
  const url = new URL(req.url)
  const token = url.searchParams.get("token") ?? req.headers.get("x-ingest-token") ?? ""
  if (!INGEST_SECRET || token !== INGEST_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get("limit") ?? "100", 10)))
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10))
  const recalc = url.searchParams.get("recalc") === "true"

  const startTime = Date.now()
  const log: string[] = []

  try {
    log.push(`Fetching Pinnacle batch offset=${offset} limit=${limit}...`)
    const batch = await fetchFlowtyPinnacleListings({
      limit,
      offset,
      listedOnly: false,
      timeoutMs: 15000,
    })
    log.push(`Fetched ${batch.length} NFTs`)

    let editionsUpserted = 0
    let editionErrors = 0
    const seenEditions = new Set<string>()

    for (const nft of batch) {
      const traits = nft.nftView?.traits?.traits ?? []
      const editionData = flowtyTraitsToPinnacleEdition(traits)
      if (!editionData.editionKey || !editionData.royaltyCode) continue

      await (supabaseAdmin as any)
        .from("pinnacle_nft_map")
        .upsert(
          {
            nft_id: nft.id,
            edition_key: editionData.editionKey,
            owner: nft.owner,
          },
          { onConflict: "nft_id", ignoreDuplicates: true }
        )

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

    const salesRows: Array<Record<string, unknown>> = []
    for (const nft of batch) {
      const { editionKey } = extractEditionKeyFromNft(nft)
      if (!editionKey) continue
      for (const order of nft.orders ?? []) {
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
      const { data, error } = await (supabaseAdmin as any).rpc("bulk_insert_pinnacle_sales", {
        sales_json: JSON.stringify(salesRows),
      })
      if (error) {
        log.push(`Sales insert error: ${error.message}`)
      } else {
        salesInserted = typeof data === "number" ? data : salesRows.length
        log.push(`Sales: ${salesInserted} inserted from ${salesRows.length} candidates`)
      }
    }

    if (recalc) {
      log.push("Triggering FMV recalc...")
      const { error: fmvError } = await (supabaseAdmin as any).rpc("pinnacle_fmv_recalc_all")
      if (fmvError) log.push(`FMV recalc error: ${fmvError.message}`)
      else log.push("FMV recalc complete")
    }

    const done = batch.length < limit
    const nextOffset = done ? null : offset + batch.length
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

    return NextResponse.json({
      ok: true,
      batchSize: batch.length,
      offset,
      nextOffset,
      done,
      editionsUpserted,
      editionErrors,
      salesInserted,
      recalcRan: recalc,
      elapsed: `${elapsed}s`,
      log,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.push(`Fatal error: ${msg}`)
    return NextResponse.json({ ok: false, error: msg, log }, { status: 500 })
  }
}
