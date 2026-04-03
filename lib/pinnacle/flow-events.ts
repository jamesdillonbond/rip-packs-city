import type { SupabaseClient } from "@supabase/supabase-js"

const FLOW_ACCESS_NODE = "https://rest-mainnet.onflow.org"
const LISTING_COMPLETED_EVENT =
  "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted"
const PINNACLE_NFT_TYPE = "A.edf9df96c92f4595.Pinnacle.NFT"
const BLOCK_CHUNK_SIZE = 250
const BACKFILL_STATE_ID = "pinnacle_flow_events"

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CompletedSale {
  nftId: string
  price: number
  buyerAddress: string
  sellerAddress: string
  blockHeight: number
  blockTimestamp: string
  transactionId: string
}

interface FlowEvent {
  type: string
  transaction_id: string
  transaction_index: string
  event_index: string
  payload: {
    type: string
    value: {
      id: string
      fields: { name: string; value: { type: string; value: string } }[]
    }
  }
}

interface FlowBlockEvents {
  block_id: string
  block_height: string
  block_timestamp: string
  events: FlowEvent[]
}

// ─── Fetch completed Pinnacle sales from Flow ───────────────────────────────

export async function fetchCompletedPinnacleSales(
  fromBlock: number,
  toBlock: number
): Promise<CompletedSale[]> {
  const url =
    `${FLOW_ACCESS_NODE}/v1/events` +
    `?type=${LISTING_COMPLETED_EVENT}` +
    `&start_height=${fromBlock}` +
    `&end_height=${toBlock}`

  const res = await fetch(url, { cache: "no-store" })

  if (!res.ok) {
    throw new Error(
      `Flow events API returned ${res.status}: ${await res.text()}`
    )
  }

  const blocks: FlowBlockEvents[] = await res.json()
  const sales: CompletedSale[] = []

  for (const block of blocks) {
    for (const event of block.events) {
      // Extract fields from the Cadence event payload
      const fields = event.payload?.value?.fields
      if (!fields) continue

      const fieldMap = new Map(
        fields.map((f) => [f.name, f.value.value])
      )

      // Only keep Pinnacle NFT sales
      const nftType = fieldMap.get("nftType") ?? ""
      if (!nftType.includes(PINNACLE_NFT_TYPE)) continue

      sales.push({
        nftId: fieldMap.get("nftID") ?? fieldMap.get("nftId") ?? "",
        price: parseFloat(fieldMap.get("salePrice") ?? "0"),
        buyerAddress: fieldMap.get("buyer") ?? "",
        sellerAddress: fieldMap.get("seller") ?? fieldMap.get("storefrontAddress") ?? "",
        blockHeight: parseInt(block.block_height, 10),
        blockTimestamp: block.block_timestamp,
        transactionId: event.transaction_id,
      })
    }
  }

  return sales
}

// ─── Get current sealed block height ────────────────────────────────────────

export async function getCurrentBlockHeight(): Promise<number> {
  const res = await fetch(
    `${FLOW_ACCESS_NODE}/v1/blocks?height=sealed`,
    { cache: "no-store" }
  )

  if (!res.ok) {
    throw new Error(
      `Flow blocks API returned ${res.status}: ${await res.text()}`
    )
  }

  const blocks = await res.json()
  // API returns an array with the sealed block
  const block = Array.isArray(blocks) ? blocks[0] : blocks
  return parseInt(block.header.height, 10)
}

// ─── Ingest completed sales into Supabase ───────────────────────────────────

export async function ingestPinnacleSalesEvents(
  supabase: SupabaseClient,
  cursor?: number
): Promise<{
  sales_ingested: number
  new_cursor: number
  errors: string[]
}> {
  const errors: string[] = []
  let salesIngested = 0

  // Read cursor from backfill_state if not provided
  let fromBlock = cursor
  if (fromBlock === undefined) {
    const { data } = await supabase
      .from("backfill_state")
      .select("cursor")
      .eq("id", BACKFILL_STATE_ID)
      .single()

    fromBlock = data?.cursor ?? undefined
  }

  const currentHeight = await getCurrentBlockHeight()

  // If no cursor exists, start from 250 blocks back
  if (fromBlock === undefined) {
    fromBlock = currentHeight - BLOCK_CHUNK_SIZE
  }

  // Process in chunks of 250 blocks
  let blockCursor = fromBlock
  while (blockCursor < currentHeight) {
    const chunkEnd = Math.min(blockCursor + BLOCK_CHUNK_SIZE - 1, currentHeight)

    try {
      const sales = await fetchCompletedPinnacleSales(blockCursor, chunkEnd)

      if (sales.length > 0) {
        const rows = sales.map((sale) => ({
          id: `flow_${sale.transactionId}_${sale.nftId}`,
          nft_id: sale.nftId,
          sale_price_usd: sale.price,
          sold_at: sale.blockTimestamp,
          source: "flow_events",
          buyer_address: sale.buyerAddress,
          seller_address: sale.sellerAddress,
          block_height: sale.blockHeight,
          transaction_id: sale.transactionId,
        }))

        const { error } = await supabase
          .from("pinnacle_sales")
          .upsert(rows, { onConflict: "id", ignoreDuplicates: true })

        if (error) {
          errors.push(`Upsert error at block ${blockCursor}: ${error.message}`)
        } else {
          salesIngested += rows.length
        }
      }
    } catch (err) {
      errors.push(
        `Fetch error blocks ${blockCursor}-${chunkEnd}: ${(err as Error).message}`
      )
    }

    blockCursor = chunkEnd + 1
  }

  // Update backfill_state cursor
  const { error: cursorError } = await supabase
    .from("backfill_state")
    .upsert(
      {
        id: BACKFILL_STATE_ID,
        cursor: currentHeight,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    )

  if (cursorError) {
    errors.push(`Cursor update error: ${cursorError.message}`)
  }

  return {
    sales_ingested: salesIngested,
    new_cursor: currentHeight,
    errors,
  }
}
