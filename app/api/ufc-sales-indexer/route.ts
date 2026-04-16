import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import crypto from "crypto"

// ── On-chain UFC Strike sales indexer ────────────────────────────────────────
// Scans Flow NFTStorefrontV2.ListingCompleted events, filters to UFC_NFT
// purchases, resolves nftID → edition via wallet_moments_cache, and writes
// dedup'd rows into the partitioned `sales` table. Events that cannot be
// mapped to an edition are written to `unmapped_sales` for later promotion,
// and every run is logged via `log_pipeline_run` so silent failures surface.

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const UFC_COLLECTION_ID = "9b4824a8-736d-4a96-b450-8dcc0c46b023"
const COLLECTION_SLUG = "ufc_strike"
const PIPELINE_NAME = "ufc-sales-indexer"
// Flowty's NFTStorefrontV2 fork (0x3cdbb3d569211ff3) is where UFC Strike moments
// trade when they move on Flow. (UFC Strike is migrating to Aptos — residual
// Flow volume is very low but we keep watching.) `nftType` here is a plain
// String, not a Type value.
const STOREFRONT_EVENT = "A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted"
const UFC_TYPE_MATCH = "UFC_NFT"
const FLOW_REST = "https://rest-mainnet.onflow.org"
const CHUNK_SIZE = 250
const DEFAULT_SCAN_RANGE = 50_000
const MAX_SCAN_RANGE = 100_000
const INTER_CHUNK_DELAY_MS = 75

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function unwrapCdc(node: unknown): unknown {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(unwrapCdc)
  if (typeof node !== "object") return node
  const { type, value } = node as { type?: string; value?: unknown }
  if (type !== undefined && value !== undefined) {
    switch (type) {
      case "Optional": return value === null ? null : unwrapCdc(value)
      case "Array": return (value as unknown[]).map(unwrapCdc)
      case "Dictionary": {
        const out: Record<string, unknown> = {}
        for (const kv of value as Array<{ key: unknown; value: unknown }>) {
          out[String(unwrapCdc(kv.key))] = unwrapCdc(kv.value)
        }
        return out
      }
      case "Struct": case "Resource": case "Event": case "Contract": case "Enum": {
        const out: Record<string, unknown> = {}
        const fields = (value as { fields?: Array<{ name: string; value: unknown }> }).fields ?? []
        for (const f of fields) out[f.name] = unwrapCdc(f.value)
        return out
      }
      case "Type":
        return { staticType: (value as { staticType?: unknown }).staticType }
      default:
        return value
    }
  }
  return node
}

interface FlowEventBlock {
  block_id: string
  block_height: string
  block_timestamp: string
  events?: Array<{ type: string; transaction_id: string; payload: string; event_index: number }>
}

async function fetchEventRange(type: string, start: number, end: number): Promise<FlowEventBlock[]> {
  const url = `${FLOW_REST}/v1/events?type=${encodeURIComponent(type)}&start_height=${start}&end_height=${end}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) {
    console.log(`[ufc-sales-indexer] events ${start}-${end} HTTP ${res.status}`)
    return []
  }
  const json = (await res.json()) as FlowEventBlock[]
  return Array.isArray(json) ? json : []
}

async function getLatestSealedHeight(): Promise<number> {
  const res = await fetch(`${FLOW_REST}/v1/blocks?height=sealed`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`blocks sealed HTTP ${res.status}`)
  const json = (await res.json()) as Array<{ header: { height: string } }>
  return Number(json[0]?.header?.height ?? 0)
}

async function runIndexer(req: NextRequest) {
  const started = Date.now()
  const startedAt = new Date().toISOString()

  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || (bearer !== TOKEN && urlToken !== TOKEN)) return unauthorized()

  const rangeParam = Number(req.nextUrl.searchParams.get("range") ?? DEFAULT_SCAN_RANGE)
  const maxRange = Math.min(Math.max(rangeParam || DEFAULT_SCAN_RANGE, CHUNK_SIZE), MAX_SCAN_RANGE)

  let rowsFound = 0
  let rowsWritten = 0
  let rowsSkipped = 0
  let cursorBefore: string | null = null
  let cursorAfter: string | null = null
  let ok = true
  let errorMsg: string | null = null
  let response: NextResponse | null = null
  const extra: Record<string, unknown> = {}

  try {
    const { data: cursorRow, error: cursorErr } = await (supabaseAdmin as any)
      .from("event_cursor")
      .select("last_processed_block")
      .eq("id", "ufc_sales")
      .single()

    if (cursorErr) {
      throw new Error(`cursor read error: ${cursorErr.message}`)
    }

    let lastBlock = Number(cursorRow?.last_processed_block ?? 0)
    const currentHeight = await getLatestSealedHeight()

    if (lastBlock === 0) {
      lastBlock = Math.max(currentHeight - maxRange, 0)
      console.log(`[ufc-sales-indexer] first run, starting from block ${lastBlock}`)
    }

    cursorBefore = String(lastBlock)
    cursorAfter = String(lastBlock)

    if (lastBlock >= currentHeight) {
      extra.message = "already up to date"
      response = NextResponse.json({
        ok: true,
        message: "already up to date",
        cursor: lastBlock,
        elapsed: Date.now() - started,
      })
      return response
    }

    const targetHeight = Math.min(lastBlock + maxRange, currentHeight)
    console.log(`[ufc-sales-indexer] scanning ${lastBlock + 1} → ${targetHeight} (${targetHeight - lastBlock} blocks)`)

    interface Sale {
      blockHeight: number
      blockTimestamp: string
      transactionId: string
      nftID: string
      salePrice: string
      commissionReceiver?: string | null
    }

    const sales: Sale[] = []
    let lastChunkEnd = lastBlock
    let rawEventsSeen = 0

    for (let s = lastBlock + 1; s <= targetHeight; s += CHUNK_SIZE) {
      const e = Math.min(s + CHUNK_SIZE - 1, targetHeight)
      try {
        const blocks = await fetchEventRange(STOREFRONT_EVENT, s, e)
        for (const blk of blocks) {
          const bh = Number(blk.block_height)
          const bts = blk.block_timestamp
          for (const evt of blk.events ?? []) {
            rawEventsSeen++
            try {
              const raw = JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))
              const payload = unwrapCdc(raw) as Record<string, any>
              const nftTypeField = payload?.nftType
              let typeID: string | undefined
              if (typeof nftTypeField === "string") typeID = nftTypeField
              else if (nftTypeField && typeof nftTypeField === "object") {
                const st = (nftTypeField as Record<string, unknown>).staticType
                if (typeof st === "string") typeID = st
                else if (st && typeof st === "object")
                  typeID = (st as Record<string, unknown>).typeID as string | undefined
              }
              if (!typeID || !typeID.includes(UFC_TYPE_MATCH)) continue
              if (payload.purchased !== true) continue

              sales.push({
                blockHeight: bh,
                blockTimestamp: bts,
                transactionId: evt.transaction_id,
                nftID: String(payload.nftID),
                salePrice: String(payload.salePrice ?? "0"),
                commissionReceiver: payload.commissionReceiver ?? null,
              })
            } catch (err) {
              console.log("[ufc-sales-indexer] decode err:", err instanceof Error ? err.message : String(err))
            }
          }
        }
        lastChunkEnd = e
        await (supabaseAdmin as any)
          .from("event_cursor")
          .update({ last_processed_block: lastChunkEnd, updated_at: new Date().toISOString() })
          .eq("id", "ufc_sales")
        cursorAfter = String(lastChunkEnd)
      } catch (err) {
        console.log(`[ufc-sales-indexer] chunk ${s}-${e} error:`, err instanceof Error ? err.message : String(err))
      }
      if (s + CHUNK_SIZE <= targetHeight) await delay(INTER_CHUNK_DELAY_MS)
    }

    rowsFound = sales.length
    console.log(
      `[ufc-sales-indexer] contract=${STOREFRONT_EVENT} range=${lastBlock + 1}-${targetHeight} rawEvents=${rawEventsSeen} found=${sales.length}`
    )

    const uniqueNftIds = [...new Set(sales.map((s) => s.nftID))]
    const nftToEditionKey = new Map<string, string>()
    if (uniqueNftIds.length > 0) {
      for (let i = 0; i < uniqueNftIds.length; i += 500) {
        const batch = uniqueNftIds.slice(i, i + 500)
        const { data } = await (supabaseAdmin as any)
          .from("wallet_moments_cache")
          .select("moment_id, edition_key")
          .eq("collection_id", UFC_COLLECTION_ID)
          .in("moment_id", batch)
        for (const row of data ?? []) {
          if (row.edition_key) nftToEditionKey.set(row.moment_id, row.edition_key)
        }
      }
    }

    const editionKeys = [...new Set(nftToEditionKey.values())]
    const editionKeyToId = new Map<string, string>()
    if (editionKeys.length > 0) {
      for (let i = 0; i < editionKeys.length; i += 500) {
        const batch = editionKeys.slice(i, i + 500)
        const { data } = await (supabaseAdmin as any)
          .from("editions")
          .select("id, external_id")
          .eq("collection_id", UFC_COLLECTION_ID)
          .in("external_id", batch)
        for (const row of data ?? []) editionKeyToId.set(row.external_id, row.id)
      }
    }

    const salesRows: any[] = []
    const unmappedRows: any[] = []
    const unresolvedNftIds: string[] = []
    for (const s of sales) {
      const editionKey = nftToEditionKey.get(s.nftID) ?? null
      const editionId = editionKey ? editionKeyToId.get(editionKey) : null
      const price = parseFloat(s.salePrice) || 0
      if (editionId) {
        salesRows.push({
          id: crypto.randomUUID(),
          edition_id: editionId,
          collection_id: UFC_COLLECTION_ID,
          collection: "ufc",
          nft_id: s.nftID,
          price_usd: price,
          serial_number: 0,
          sold_at: s.blockTimestamp,
          marketplace: "flowty",
          source: "onchain",
          block_height: s.blockHeight,
          transaction_hash: s.transactionId,
          buyer_address: s.commissionReceiver ?? null,
          seller_address: null,
          ingested_at: new Date().toISOString(),
        })
      } else {
        unresolvedNftIds.push(s.nftID)
        const hint: Record<string, unknown> = { nft_id: s.nftID }
        if (editionKey) hint.edition_id = editionKey
        unmappedRows.push({
          id: crypto.randomUUID(),
          collection_id: UFC_COLLECTION_ID,
          nft_id: s.nftID,
          serial_number: 0,
          price_usd: price,
          marketplace: "flowty",
          transaction_hash: s.transactionId,
          block_height: s.blockHeight,
          sold_at: s.blockTimestamp,
          ingested_at: new Date().toISOString(),
          source: "onchain",
          buyer_address: s.commissionReceiver ?? null,
          seller_address: null,
          resolution_hint: hint,
        })
      }
    }

    for (let i = 0; i < salesRows.length; i += 100) {
      const batch = salesRows.slice(i, i + 100)
      const { error } = await (supabaseAdmin as any).from("sales").insert(batch)
      if (error) {
        if (error.code === "23505") {
          // dupes
        } else {
          console.log("[ufc-sales-indexer] sales batch insert err:", error.message)
          for (const row of batch) {
            const { error: se } = await (supabaseAdmin as any).from("sales").insert(row)
            if (!se) rowsWritten++
          }
        }
      } else {
        rowsWritten += batch.length
      }
    }

    for (let i = 0; i < unmappedRows.length; i += 100) {
      const batch = unmappedRows.slice(i, i + 100)
      const { error } = await (supabaseAdmin as any).from("unmapped_sales").insert(batch)
      if (error) {
        if (error.code === "23505") {
          // dupes
        } else {
          console.log("[ufc-sales-indexer] unmapped batch insert err:", error.message)
          for (const row of batch) {
            const { error: se } = await (supabaseAdmin as any).from("unmapped_sales").insert(row)
            if (!se) rowsSkipped++
          }
        }
      } else {
        rowsSkipped += batch.length
      }
    }

    extra.blocks_scanned = targetHeight - lastBlock
    extra.unresolved_sample = unresolvedNftIds.slice(0, 20)
    extra.elapsed_ms = Date.now() - started

    response = NextResponse.json({
      ok: true,
      blocksScanned: targetHeight - lastBlock,
      eventsFound: sales.length,
      salesResolved: salesRows.length,
      salesInserted: rowsWritten,
      unmappedInserted: rowsSkipped,
      unresolved: unresolvedNftIds.slice(0, 50),
      unresolvedCount: unresolvedNftIds.length,
      cursor: lastChunkEnd,
      elapsed: Date.now() - started,
    })
  } catch (err) {
    ok = false
    errorMsg = err instanceof Error ? err.message : String(err)
    console.log("[ufc-sales-indexer] fatal:", errorMsg)
    response = NextResponse.json(
      { error: "Internal server error", details: errorMsg },
      { status: 500 }
    )
  } finally {
    try {
      await (supabaseAdmin as any).rpc("promote_unmapped_sales", {
        p_collection_id: UFC_COLLECTION_ID,
      })
    } catch (e) {
      console.log(
        "[ufc-sales-indexer] promote_unmapped_sales err:",
        e instanceof Error ? e.message : String(e)
      )
    }
    try {
      await (supabaseAdmin as any).rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAt,
        p_rows_found: rowsFound,
        p_rows_written: rowsWritten,
        p_rows_skipped: rowsSkipped,
        p_ok: ok,
        p_error: errorMsg,
        p_collection_slug: COLLECTION_SLUG,
        p_cursor_before: cursorBefore,
        p_cursor_after: cursorAfter,
        p_extra: Object.keys(extra).length > 0 ? extra : null,
      })
    } catch (e) {
      console.log(
        "[ufc-sales-indexer] log_pipeline_run err:",
        e instanceof Error ? e.message : String(e)
      )
    }
  }

  return response ?? NextResponse.json({ ok: false, error: "no response" }, { status: 500 })
}

export async function GET(req: NextRequest) { return runIndexer(req) }
export async function POST(req: NextRequest) { return runIndexer(req) }
