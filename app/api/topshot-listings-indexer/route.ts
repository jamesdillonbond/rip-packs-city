import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── On-chain Top Shot listings indexer ───────────────────────────────────────
//
// Reads Dapper's NFTStorefrontV2 at 0x4eb8a10cb9f87357 (verified 2026-05-17 to
// emit ListingAvailable and ListingCompleted with payload shapes identical to
// the Flowty fork the AllDay/Golazos/UFC indexers consume). Filters to
// TopShot NFT nftType — explicitly NOT PackNFT.NFT, which shares the same
// storefront contract and is handled by workers/pack-events-ingest.
//
// Resolution chain (TopShot, simpler than the others): on-chain nftID →
// wallet_moments_cache.edition_key — and for TopShot that key IS already the
// editions UUID (verified 1.18M rows, 8834 distinct UUID-shaped keys). No
// external_id roundtrip. Unresolved rows still write with edition_id=NULL so
// the chain event isn't lost; downstream resolvers can backfill when wmc
// catches up.
//
// v1 drops the listing_resolution_failures retry queue + Cadence borrow
// fallback that AllDay carries. Graft them back from allday-listings-indexer
// if production diverges.
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const COLLECTION_SLUG = "nba_top_shot"
const PIPELINE_NAME = "topshot-listings-indexer"
const TOPSHOT_NFT_TYPE_ID = "A.0b2a3299cc857e29.TopShot.NFT"
const PACKNFT_TYPE_ID = "A.0b2a3299cc857e29.PackNFT.NFT"

// Dapper NFTStorefrontV2 — distinct from the Flowty fork (0x3cdbb3d569211ff3)
// that hosts AllDay/Golazos/UFC. Same NFTStorefrontV2 standard, identical
// ListingAvailable/ListingCompleted payload fields.
const STOREFRONT_LISTING_AVAILABLE = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingAvailable"
const STOREFRONT_LISTING_COMPLETED = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted"
const FLOW_REST = "https://rest-mainnet.onflow.org"
const CHUNK_SIZE = 250
const DEFAULT_SCAN_RANGE = 25_000
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
      case "Optional":
        return value === null ? null : unwrapCdc(value)
      case "Array":
        return (value as unknown[]).map(unwrapCdc)
      case "Dictionary": {
        const out: Record<string, unknown> = {}
        for (const kv of value as Array<{ key: unknown; value: unknown }>) {
          out[String(unwrapCdc(kv.key))] = unwrapCdc(kv.value)
        }
        return out
      }
      case "Struct":
      case "Resource":
      case "Event":
      case "Contract":
      case "Enum": {
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
  block_height: string
  block_timestamp: string
  events?: Array<{ type: string; transaction_id: string; payload: string; event_index: number }>
}

async function fetchEventRange(type: string, start: number, end: number): Promise<FlowEventBlock[]> {
  const url = `${FLOW_REST}/v1/events?type=${encodeURIComponent(type)}&start_height=${start}&end_height=${end}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) {
    console.log(`[${PIPELINE_NAME}] events ${start}-${end} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
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

function epochSecondsToIso(raw: unknown): string | null {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n * 1000).toISOString()
}

interface ListingAvailableEvent {
  blockHeight: number
  blockTimestamp: string
  txHash: string
  eventIndex: number
  listingResourceID: string
  storefrontAddress: string
  nftID: string
  salePrice: string
  salePaymentVaultType: string | undefined
  customID: string | null
  expiry: string | undefined
}

interface ListingCompletedEvent {
  blockTimestamp: string
  listingResourceID: string
  purchased: boolean
}

export async function POST(req: NextRequest) {
  const start = Date.now()
  const startedAt = new Date().toISOString()

  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || (bearer !== TOKEN && urlToken !== TOKEN)) return unauthorized()

  const rangeParam = Number(req.nextUrl.searchParams.get("range") ?? DEFAULT_SCAN_RANGE)
  const maxRange = Math.min(Math.max(rangeParam || DEFAULT_SCAN_RANGE, CHUNK_SIZE), MAX_SCAN_RANGE)

  after(async () => {
    let rowsFound = 0
    let rowsWritten = 0
    let rowsSkipped = 0
    let cursorBefore: string | null = null
    let cursorAfter: string | null = null
    let ok = true
    let errorMsg: string | null = null
    const extra: Record<string, unknown> = {}

    let listingsAvailableCount = 0
    let listingsCompletedCount = 0
    let packListingsSkipped = 0
    const unresolvedSample: string[] = []

    try {
      const { data: cursorRow, error: cursorErr } = await (supabaseAdmin as any)
        .from("event_cursor")
        .select("last_processed_block")
        .eq("id", "topshot_listings")
        .single()

      if (cursorErr) throw new Error(`cursor read error: ${cursorErr.message}`)

      let lastBlock = Number(cursorRow?.last_processed_block ?? 0)
      const currentHeight = await getLatestSealedHeight()

      if (lastBlock === 0) {
        await (supabaseAdmin as any)
          .from("event_cursor")
          .update({ last_processed_block: currentHeight, updated_at: new Date().toISOString() })
          .eq("id", "topshot_listings")
        cursorBefore = "0"
        cursorAfter = String(currentHeight)
        extra.message = "first run, cursor anchored to sealed tip"
        extra.sealed_tip = currentHeight
        return
      }

      cursorBefore = String(lastBlock)
      const targetHeight = Math.min(lastBlock + maxRange, currentHeight)
      cursorAfter = String(lastBlock)

      if (lastBlock >= currentHeight) {
        extra.message = "already up to date"
        return
      }

      console.log(`[${PIPELINE_NAME}] scanning ${lastBlock + 1} → ${targetHeight} (${targetHeight - lastBlock} blocks)`)

      const availableEvents: ListingAvailableEvent[] = []
      const completedEvents: ListingCompletedEvent[] = []
      let rawAvailable = 0
      let rawCompleted = 0

      for (let s = lastBlock + 1; s <= targetHeight; s += CHUNK_SIZE) {
        const e = Math.min(s + CHUNK_SIZE - 1, targetHeight)
        try {
          const [availBlocks, complBlocks] = await Promise.all([
            fetchEventRange(STOREFRONT_LISTING_AVAILABLE, s, e),
            fetchEventRange(STOREFRONT_LISTING_COMPLETED, s, e),
          ])

          for (const blk of availBlocks) {
            const bh = Number(blk.block_height)
            const bts = blk.block_timestamp
            for (const evt of blk.events ?? []) {
              rawAvailable++
              try {
                const raw = JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))
                const payload = unwrapCdc(raw) as Record<string, any>
                const nftTypeId = extractTypeId(payload?.nftType)
                if (!nftTypeId) continue
                if (nftTypeId === PACKNFT_TYPE_ID) {
                  // Pack listings travel through the same storefront contract;
                  // pack-events-ingest already handles them via its own pack
                  // purchase cursor.
                  packListingsSkipped++
                  continue
                }
                if (nftTypeId !== TOPSHOT_NFT_TYPE_ID && !nftTypeId.includes(".TopShot.NFT")) continue

                const storefrontAddress = typeof payload.storefrontAddress === "string" ? payload.storefrontAddress : null
                if (!storefrontAddress) continue

                availableEvents.push({
                  blockHeight: bh,
                  blockTimestamp: bts,
                  txHash: evt.transaction_id,
                  eventIndex: evt.event_index,
                  listingResourceID: String(payload.listingResourceID),
                  storefrontAddress,
                  nftID: String(payload.nftID),
                  salePrice: String(payload.salePrice ?? "0"),
                  salePaymentVaultType: extractTypeId(payload.salePaymentVaultType),
                  customID: typeof payload.customID === "string" ? payload.customID : null,
                  expiry: payload.expiry !== undefined && payload.expiry !== null ? String(payload.expiry) : undefined,
                })
              } catch (err) {
                console.log(`[${PIPELINE_NAME}] available decode err:`, err instanceof Error ? err.message : String(err))
              }
            }
          }

          for (const blk of complBlocks) {
            const bts = blk.block_timestamp
            for (const evt of blk.events ?? []) {
              rawCompleted++
              try {
                const raw = JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))
                const payload = unwrapCdc(raw) as Record<string, any>
                const nftTypeId = extractTypeId(payload?.nftType)
                if (!nftTypeId) continue
                if (nftTypeId === PACKNFT_TYPE_ID) continue
                if (nftTypeId !== TOPSHOT_NFT_TYPE_ID && !nftTypeId.includes(".TopShot.NFT")) continue

                completedEvents.push({
                  blockTimestamp: bts,
                  listingResourceID: String(payload.listingResourceID),
                  purchased: payload.purchased === true,
                })
              } catch (err) {
                console.log(`[${PIPELINE_NAME}] completed decode err:`, err instanceof Error ? err.message : String(err))
              }
            }
          }
        } catch (err) {
          console.log(`[${PIPELINE_NAME}] chunk ${s}-${e} error:`, err instanceof Error ? err.message : String(err))
        }
        if (s + CHUNK_SIZE <= targetHeight) await delay(INTER_CHUNK_DELAY_MS)
      }

      listingsAvailableCount = availableEvents.length
      listingsCompletedCount = completedEvents.length
      rowsFound = listingsAvailableCount + listingsCompletedCount

      console.log(`[${PIPELINE_NAME}] range=${lastBlock + 1}-${targetHeight} rawAvail=${rawAvailable} rawCompl=${rawCompleted} availFiltered=${listingsAvailableCount} complFiltered=${listingsCompletedCount} packSkipped=${packListingsSkipped}`)

      // TopShot wmc.edition_key IS already the editions UUID — no
      // external_id roundtrip. Direct map nftID → edition_id.
      const uniqueNftIds = [...new Set(availableEvents.map((a) => a.nftID))]
      const nftToEditionUuid = new Map<string, string>()
      if (uniqueNftIds.length > 0) {
        for (let i = 0; i < uniqueNftIds.length; i += 500) {
          const batch = uniqueNftIds.slice(i, i + 500)
          const { data } = await (supabaseAdmin as any)
            .from("wallet_moments_cache")
            .select("moment_id, edition_key")
            .eq("collection_id", TOPSHOT_COLLECTION_ID)
            .in("moment_id", batch)
          for (const row of data ?? []) {
            if (row.edition_key) nftToEditionUuid.set(row.moment_id, row.edition_key)
          }
        }
      }

      const v2Rows: any[] = []
      for (const a of availableEvents) {
        const editionUuid = nftToEditionUuid.get(a.nftID) ?? null
        if (!editionUuid && unresolvedSample.length < 20) unresolvedSample.push(a.nftID)

        const currency = deriveCurrency(a.salePaymentVaultType)
        const salePriceNum = parseFloat(a.salePrice) || 0
        const priceUsd = isUsdEquivalent(currency) ? salePriceNum : null

        v2Rows.push({
          listing_resource_id: a.listingResourceID,
          source: "direct",
          flow_id: a.nftID,
          edition_id: editionUuid,
          collection_id: TOPSHOT_COLLECTION_ID,
          seller_address: a.storefrontAddress,
          price_usd: priceUsd,
          currency,
          custom_id: a.customID,
          listed_at: a.blockTimestamp,
          expiry_at: epochSecondsToIso(a.expiry),
          completed_at: null,
          completed_status: null,
          block_height: a.blockHeight,
          tx_hash: a.txHash,
          event_index: a.eventIndex,
        })
      }

      for (let i = 0; i < v2Rows.length; i += 100) {
        const batch = v2Rows.slice(i, i + 100)
        const { error } = await (supabaseAdmin as any)
          .from("cached_listings_v2")
          .upsert(batch, { onConflict: "listing_resource_id,source", ignoreDuplicates: false })
        if (error) {
          console.log(`[${PIPELINE_NAME}] v2 upsert err:`, error.message)
          for (const row of batch) {
            const { error: se } = await (supabaseAdmin as any)
              .from("cached_listings_v2")
              .upsert(row, { onConflict: "listing_resource_id,source", ignoreDuplicates: false })
            if (!se) rowsWritten++
            else rowsSkipped++
          }
        } else {
          rowsWritten += batch.length
        }
      }

      let completedMatched = 0
      let completedSkipped = 0
      for (const c of completedEvents) {
        const status = c.purchased ? "purchased" : "cancelled"
        const { data: updated, error: updErr } = await (supabaseAdmin as any)
          .from("cached_listings_v2")
          .update({ completed_at: c.blockTimestamp, completed_status: status })
          .eq("listing_resource_id", c.listingResourceID)
          .eq("source", "direct")
          .is("completed_at", null)
          .select("listing_resource_id")
        if (updErr) {
          console.log(`[${PIPELINE_NAME}] complete update err lrid=${c.listingResourceID}:`, updErr.message)
          continue
        }
        if (updated && updated.length > 0) completedMatched++
        else completedSkipped++
      }

      await (supabaseAdmin as any)
        .from("event_cursor")
        .update({ last_processed_block: targetHeight, updated_at: new Date().toISOString() })
        .eq("id", "topshot_listings")
      cursorAfter = String(targetHeight)

      extra.blocks_scanned = targetHeight - lastBlock
      extra.events_pre_filter = rawAvailable + rawCompleted
      extra.events_post_filter = rowsFound
      extra.listings_available_count = listingsAvailableCount
      extra.listings_completed_count = listingsCompletedCount
      extra.pack_listings_skipped = packListingsSkipped
      extra.completed_matched = completedMatched
      extra.completed_unmatched = completedSkipped
      extra.unresolved_sample = unresolvedSample
      extra.elapsed_ms = Date.now() - start
    } catch (err) {
      ok = false
      errorMsg = err instanceof Error ? err.message : String(err)
      console.log(`[${PIPELINE_NAME}] fatal:`, errorMsg)
    } finally {
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
        console.log(`[${PIPELINE_NAME}] log_pipeline_run err:`, e instanceof Error ? e.message : String(e))
      }
    }
  })

  return NextResponse.json({ ok: true, message: "indexing started" })
}

export async function GET(req: NextRequest) {
  return POST(req)
}
