// app/api/cron/pinnacle-events-ingest/route.ts
//
// Phase 2B of the chain-event Pinnacle listings ingest. Reads the cursor
// for A.4eb8a10cb9f87357.NFTStorefrontV2.ListingAvailable, asks the
// pinnacle-events-proxy Worker for the next 10K blocks of events, filters
// to Pinnacle NFTs by nftType.staticType.typeID, upserts into
// pinnacle_listing_events. Logs to pipeline_runs.
//
// Bearer auth: INGEST_SECRET_TOKEN.
// Schedule (manual, cron-job.org): */15 minutes.
//
// First-run init: anchors cursor at the current sealed tip with NO
// backscan, matching app/api/allday-listings-indexer/route.ts's first-run
// behavior. Historical fill is a separate workstream (the worker
// supports it; a one-shot script analogous to
// scripts/backfill-allday-listings-historical.mjs can be written later).

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE = "pinnacle-events-ingest"
const EVENT_TYPE = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingAvailable"
const PINNACLE_NFT_TYPE_ID = "A.edf9df96c92f4595.Pinnacle.NFT"
const PROXY_URL = process.env.PINNACLE_EVENTS_PROXY_URL
  || "https://pinnacle-events-proxy.tdillonbond.workers.dev"
const FLOW_REST = "https://rest-mainnet.onflow.org"

// Per-tick window. Walker caps at 10K so a single 15-min tick stays
// well inside the 300s maxDuration even with 40 chunked requests at
// ~67ms each (~2.7s wall-clock minimum, plus event processing).
const BLOCKS_PER_TICK = 10_000

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

function unwrapCdc(node: unknown): unknown {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(unwrapCdc)
  if (typeof node !== "object") return node
  const { type, value } = node as { type?: string; value?: unknown }
  if (type !== undefined && value !== undefined) {
    switch (type) {
      case "Optional":
        return value === null ? null : unwrapCdc(value)
      case "Bool":
      case "String":
      case "Address":
      case "Path":
      case "Character":
        return value
      case "Int": case "UInt":
      case "Int8": case "Int16": case "Int32": case "Int64": case "Int128": case "Int256":
      case "UInt8": case "UInt16": case "UInt32": case "UInt64": case "UInt128": case "UInt256":
      case "Word8": case "Word16": case "Word32": case "Word64":
      case "Fix64": case "UFix64":
        return value
      case "Array":
        return (value as unknown[]).map(unwrapCdc)
      case "Dictionary": {
        const arr = value as Array<{ key: unknown; value: unknown }>
        const out: Record<string, unknown> = {}
        for (const entry of arr) out[String(unwrapCdc(entry.key))] = unwrapCdc(entry.value)
        return out
      }
      case "Struct": case "Resource": case "Event": case "Contract": case "Enum": {
        const out: Record<string, unknown> = {}
        const v = value as { fields?: Array<{ name: string; value: unknown }> }
        for (const f of v.fields ?? []) out[f.name] = unwrapCdc(f.value)
        return out
      }
      default:
        return value
    }
  }
  return node
}

function extractTypeId(field: unknown): string | undefined {
  if (typeof field === "string") return field
  if (field && typeof field === "object") {
    const st = (field as Record<string, unknown>).staticType
    if (typeof st === "string") return st
    if (st && typeof st === "object") {
      const id = (st as Record<string, unknown>).typeID
      if (typeof id === "string") return id
    }
  }
  return undefined
}

function deriveCurrency(vaultTypeId: string | undefined): string {
  if (!vaultTypeId) return "UNKNOWN"
  if (vaultTypeId.includes("DapperUtilityCoin")) return "DUC"
  if (vaultTypeId.includes("FlowUtilityToken")) return "FUT"
  if (vaultTypeId.includes("FlowToken")) return "FLOW"
  if (vaultTypeId.includes("FUSD")) return "FUSD"
  return vaultTypeId
}

function isUsdEquivalent(currency: string): boolean {
  return currency === "DUC" || currency === "FUT"
}

async function getLatestSealedHeight(): Promise<number> {
  const res = await fetch(`${FLOW_REST}/v1/blocks?height=sealed`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`blocks sealed HTTP ${res.status}`)
  const json = (await res.json()) as Array<{ header: { height: string } }>
  return Number(json[0]?.header?.height ?? 0)
}

interface ProxyEvent {
  block_height: number
  block_timestamp: string
  transaction_id: string
  event_index: number
  type: string
  payload: string
}

export async function POST(req: NextRequest) {
  const expected = process.env.INGEST_SECRET_TOKEN
  if (!expected) return NextResponse.json({ error: "INGEST_SECRET_TOKEN not set" }, { status: 500 })
  const auth = req.headers.get("authorization") ?? ""
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (auth !== `Bearer ${expected}` && urlToken !== expected) return unauthorized()

  const startedAtIso = new Date().toISOString()
  const startedMs = Date.now()

  after(async () => {
    let ok = true
    let errorMsg: string | null = null
    const extra: Record<string, unknown> = {}
    let rowsFound = 0
    let rowsWritten = 0
    let cursorBefore: string | null = null
    let cursorAfter: string | null = null

    try {
      // Read cursor. First-run init = anchor at sealed tip, exit clean.
      const { data: cursorRow } = await (supabaseAdmin as any)
        .from("pinnacle_event_cursors")
        .select("last_processed_height")
        .eq("event_type", EVENT_TYPE)
        .maybeSingle()

      const sealedHeight = await getLatestSealedHeight()

      if (!cursorRow) {
        await (supabaseAdmin as any)
          .from("pinnacle_event_cursors")
          .upsert({ event_type: EVENT_TYPE, last_processed_height: sealedHeight, updated_at: new Date().toISOString() })
        cursorBefore = "0"
        cursorAfter = String(sealedHeight)
        extra.message = "first run, cursor anchored to sealed tip"
        extra.sealed_tip = sealedHeight
        return
      }

      const lastBlock = Number(cursorRow.last_processed_height ?? 0)
      cursorBefore = String(lastBlock)
      if (lastBlock >= sealedHeight) {
        cursorAfter = String(lastBlock)
        extra.message = "already up to date"
        extra.sealed_tip = sealedHeight
        return
      }

      const startHeight = lastBlock + 1
      const endHeight = Math.min(lastBlock + BLOCKS_PER_TICK, sealedHeight)

      // Call the worker. Bearer auth shared via INGEST_SECRET_TOKEN.
      const proxyRes = await fetch(`${PROXY_URL}/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${expected}`,
        },
        body: JSON.stringify({ startHeight, endHeight }),
        signal: AbortSignal.timeout(280_000),
      })
      if (!proxyRes.ok) {
        const rawDetail = await proxyRes.text()
        const isHtml = rawDetail.startsWith("<!DOCTYPE")
          || rawDetail.startsWith("<html")
          || (proxyRes.headers.get("content-type") ?? "").includes("text/html")
        if (isHtml && proxyRes.status === 404) {
          throw new Error(
            `proxy_returned_404_html — worker route not matched OR cloudflare edge unrouted; ` +
            `verify https://pinnacle-events-proxy.tdillonbond.workers.dev/ health and wrangler deploy state. ` +
            `range=${startHeight}..${endHeight} sealed_tip=${sealedHeight}`
          )
        }
        if (isHtml) {
          throw new Error(
            `proxy_returned_html status=${proxyRes.status} — non-JSON response from worker URL; ` +
            `likely cloudflare edge or origin error. range=${startHeight}..${endHeight}`
          )
        }
        throw new Error(`proxy HTTP ${proxyRes.status}: ${rawDetail.slice(0, 300)}`)
      }
      const body = (await proxyRes.json()) as {
        events?: ProxyEvent[]
        cursor?: number
        complete?: boolean
        blocks_scanned?: number
      }
      const allEvents: ProxyEvent[] = body.events ?? []
      extra.blocks_scanned = body.blocks_scanned ?? (endHeight - startHeight + 1)
      extra.proxy_events_total = allEvents.length

      // Filter to Pinnacle NFTs + decode payload.
      const insertRows: Array<Record<string, unknown>> = []
      let pinnacleMatched = 0
      let undecodeable = 0
      for (const evt of allEvents) {
        rowsFound++
        try {
          const raw = JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))
          const payload = unwrapCdc(raw) as Record<string, unknown>
          const nftTypeId = extractTypeId(payload?.nftType)
          if (nftTypeId !== PINNACLE_NFT_TYPE_ID) continue
          pinnacleMatched++

          const sellerAddress = typeof payload.storefrontAddress === "string" ? payload.storefrontAddress : null
          if (!sellerAddress) continue

          const listingResourceID = String(payload.listingResourceID)
          const nftID = String(payload.nftID)
          const salePrice = parseFloat(String(payload.salePrice ?? "0")) || 0
          const vaultTypeId = extractTypeId(payload.salePaymentVaultType)
          const currency = deriveCurrency(vaultTypeId)
          const priceUsd = isUsdEquivalent(currency) ? salePrice : null

          insertRows.push({
            event_type: EVENT_TYPE,
            block_height: evt.block_height,
            transaction_hash: evt.transaction_id,
            listing_resource_id: listingResourceID,
            nft_id: nftID,
            seller_address: sellerAddress,
            price_native: salePrice,
            currency,
            price_usd: priceUsd,
            listed_at: evt.block_timestamp,
            raw: { nftTypeId, vaultTypeId, payload },
          })
        } catch (decodeErr) {
          undecodeable++
          console.log(`[${PIPELINE}] decode err tx=${evt.transaction_id}: ${decodeErr instanceof Error ? decodeErr.message : String(decodeErr)}`)
        }
      }
      extra.pinnacle_matched = pinnacleMatched
      extra.undecodeable = undecodeable

      // Upsert by (transaction_hash, listing_resource_id).
      for (let i = 0; i < insertRows.length; i += 100) {
        const batch = insertRows.slice(i, i + 100)
        const { error } = await (supabaseAdmin as any)
          .from("pinnacle_listing_events")
          .upsert(batch, { onConflict: "transaction_hash,listing_resource_id", ignoreDuplicates: true })
        if (error) {
          console.log(`[${PIPELINE}] upsert err chunk=${i}: ${error.message}`)
        } else {
          rowsWritten += batch.length
        }
      }

      // Advance cursor only after successful upserts.
      await (supabaseAdmin as any)
        .from("pinnacle_event_cursors")
        .upsert({ event_type: EVENT_TYPE, last_processed_height: endHeight, updated_at: new Date().toISOString() })
      cursorAfter = String(endHeight)
      extra.cursor_advanced_by_blocks = endHeight - lastBlock
    } catch (err) {
      ok = false
      errorMsg = err instanceof Error ? err.message : String(err)
      console.log(`[${PIPELINE}] fatal: ${errorMsg}`)
    } finally {
      extra.elapsed_ms = Date.now() - startedMs
      try {
        await (supabaseAdmin as any).rpc("log_pipeline_run", {
          p_pipeline: PIPELINE,
          p_started_at: startedAtIso,
          p_rows_found: rowsFound,
          p_rows_written: rowsWritten,
          p_rows_skipped: rowsFound - rowsWritten,
          p_ok: ok,
          p_error: errorMsg,
          p_collection_slug: "disney_pinnacle",
          p_cursor_before: cursorBefore,
          p_cursor_after: cursorAfter,
          p_extra: Object.keys(extra).length > 0 ? extra : null,
        })
      } catch (logErr) {
        console.log(`[${PIPELINE}] log_pipeline_run err: ${logErr instanceof Error ? logErr.message : String(logErr)}`)
      }
    }
  })

  return NextResponse.json({ ok: true, message: "ingest queued", started_at: startedAtIso })
}

export async function GET(req: NextRequest) {
  return POST(req)
}
