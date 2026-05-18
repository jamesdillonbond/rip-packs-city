import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── On-chain UFC Strike listings indexer (triple storefront scan) ────────────
//
// Mirrors allday-listings-indexer's triple-scan design. Lean shape: no Sentry
// breadcrumbs, no listing_resolution_failures retry queue, no Cadence
// seller-borrow fallback. UFC Strike is migrating to Aptos so listing churn
// on Flow is minimal anyway.
//
// V1 Dapper:  A.4eb8a10cb9f87357.NFTStorefront     — original Dapper storefront
// V2 Dapper:  A.4eb8a10cb9f87357.NFTStorefrontV2   — primary venue today
// V2 Flowty:  A.3cdbb3d569211ff3.NFTStorefrontV2   — dormant fork
//
// V1 rows land with source='direct_v1'; V2 Dapper with source='direct_v2';
// V2 Flowty with source='direct'.
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const UFC_COLLECTION_ID = "9b4824a8-736d-4a96-b450-8dcc0c46b023"
const COLLECTION_SLUG = "ufc_strike"
const PIPELINE_NAME = "ufc-listings-indexer"
const UFC_NFT_TYPE_SUFFIX = ".UFC_NFT.NFT"

const V1_LISTING_AVAILABLE = "A.4eb8a10cb9f87357.NFTStorefront.ListingAvailable"
const V1_LISTING_COMPLETED = "A.4eb8a10cb9f87357.NFTStorefront.ListingCompleted"
const V2_DAPPER_LISTING_AVAILABLE = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingAvailable"
const V2_DAPPER_LISTING_COMPLETED = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted"
const V2_FLOWTY_LISTING_AVAILABLE = "A.3cdbb3d569211ff3.NFTStorefrontV2.ListingAvailable"
const V2_FLOWTY_LISTING_COMPLETED = "A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted"

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
    console.log(`[${PIPELINE_NAME}] events ${start}-${end} ${type.split(".").pop()} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
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

type StorefrontVersion = "v1" | "v2_dapper" | "v2_flowty"

interface ListingAvailableEvent {
  storefrontVersion: StorefrontVersion
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
  storefrontVersion: StorefrontVersion
  blockTimestamp: string
  listingResourceID: string
  purchased: boolean
}

function sourceFor(v: StorefrontVersion): "direct_v1" | "direct_v2" | "direct" {
  if (v === "v1") return "direct_v1"
  if (v === "v2_dapper") return "direct_v2"
  return "direct"
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
    const unresolvedSample: string[] = []

    try {
      const { data: cursorRow, error: cursorErr } = await (supabaseAdmin as any)
        .from("event_cursor")
        .select("last_processed_block")
        .eq("id", "ufc_listings")
        .single()

      if (cursorErr) throw new Error(`cursor read error: ${cursorErr.message}`)

      let lastBlock = Number(cursorRow?.last_processed_block ?? 0)
      const currentHeight = await getLatestSealedHeight()

      if (lastBlock === 0) {
        await (supabaseAdmin as any)
          .from("event_cursor")
          .update({ last_processed_block: currentHeight, updated_at: new Date().toISOString() })
          .eq("id", "ufc_listings")
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
      let rawV1Avail = 0
      let rawV1Compl = 0
      let rawV2DapperAvail = 0
      let rawV2DapperCompl = 0
      let rawV2FlowtyAvail = 0
      let rawV2FlowtyCompl = 0
      const v2DapperTypeIds = new Set<string>()

      for (let s = lastBlock + 1; s <= targetHeight; s += CHUNK_SIZE) {
        const e = Math.min(s + CHUNK_SIZE - 1, targetHeight)
        try {
          const [
            v1AvailBlocks,
            v1ComplBlocks,
            v2DapperAvailBlocks,
            v2DapperComplBlocks,
            v2FlowtyAvailBlocks,
            v2FlowtyComplBlocks,
          ] = await Promise.all([
            fetchEventRange(V1_LISTING_AVAILABLE, s, e),
            fetchEventRange(V1_LISTING_COMPLETED, s, e),
            fetchEventRange(V2_DAPPER_LISTING_AVAILABLE, s, e),
            fetchEventRange(V2_DAPPER_LISTING_COMPLETED, s, e),
            fetchEventRange(V2_FLOWTY_LISTING_AVAILABLE, s, e),
            fetchEventRange(V2_FLOWTY_LISTING_COMPLETED, s, e),
          ])

          const processAvail = (blocks: FlowEventBlock[], version: StorefrontVersion, incr: () => void) => {
            for (const blk of blocks) {
              const bh = Number(blk.block_height)
              const bts = blk.block_timestamp
              for (const evt of blk.events ?? []) {
                incr()
                try {
                  const raw = JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))
                  const payload = unwrapCdc(raw) as Record<string, any>
                  const nftTypeId = extractTypeId(payload?.nftType)
                  if (version === "v2_dapper" && nftTypeId) v2DapperTypeIds.add(nftTypeId)
                  if (!nftTypeId || !nftTypeId.endsWith(UFC_NFT_TYPE_SUFFIX)) continue

                  const storefrontAddress = typeof payload.storefrontAddress === "string" ? payload.storefrontAddress : null
                  if (!storefrontAddress) continue

                  const priceField = payload.price ?? payload.salePrice
                  const vaultField = payload.ftVaultType ?? payload.salePaymentVaultType

                  availableEvents.push({
                    storefrontVersion: version,
                    blockHeight: bh,
                    blockTimestamp: bts,
                    txHash: evt.transaction_id,
                    eventIndex: evt.event_index,
                    listingResourceID: String(payload.listingResourceID),
                    storefrontAddress,
                    nftID: String(payload.nftID),
                    salePrice: String(priceField ?? "0"),
                    salePaymentVaultType: extractTypeId(vaultField),
                    customID: typeof payload.customID === "string" ? payload.customID : null,
                    expiry: payload.expiry !== undefined && payload.expiry !== null ? String(payload.expiry) : undefined,
                  })
                } catch (err) {
                  console.log(`[${PIPELINE_NAME}] available decode err:`, err instanceof Error ? err.message : String(err))
                }
              }
            }
          }

          const processCompl = (blocks: FlowEventBlock[], version: StorefrontVersion, incr: () => void) => {
            for (const blk of blocks) {
              const bh = Number(blk.block_height)
              const bts = blk.block_timestamp
              for (const evt of blk.events ?? []) {
                incr()
                try {
                  const raw = JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))
                  const payload = unwrapCdc(raw) as Record<string, any>
                  const nftTypeId = extractTypeId(payload?.nftType)
                  if (version === "v2_dapper" && nftTypeId) v2DapperTypeIds.add(nftTypeId)
                  if (!nftTypeId || !nftTypeId.endsWith(UFC_NFT_TYPE_SUFFIX)) continue

                  completedEvents.push({
                    storefrontVersion: version,
                    blockTimestamp: bts,
                    listingResourceID: String(payload.listingResourceID),
                    purchased: payload.purchased === true,
                  })
                } catch (err) {
                  console.log(`[${PIPELINE_NAME}] completed decode err:`, err instanceof Error ? err.message : String(err))
                }
              }
            }
          }

          processAvail(v1AvailBlocks, "v1", () => rawV1Avail++)
          processCompl(v1ComplBlocks, "v1", () => rawV1Compl++)
          processAvail(v2DapperAvailBlocks, "v2_dapper", () => rawV2DapperAvail++)
          processCompl(v2DapperComplBlocks, "v2_dapper", () => rawV2DapperCompl++)
          processAvail(v2FlowtyAvailBlocks, "v2_flowty", () => rawV2FlowtyAvail++)
          processCompl(v2FlowtyComplBlocks, "v2_flowty", () => rawV2FlowtyCompl++)
        } catch (err) {
          console.log(`[${PIPELINE_NAME}] chunk ${s}-${e} error:`, err instanceof Error ? err.message : String(err))
        }
        if (s + CHUNK_SIZE <= targetHeight) await delay(INTER_CHUNK_DELAY_MS)
      }

      const v1AvailCount = availableEvents.filter((a) => a.storefrontVersion === "v1").length
      const v2DapperAvailCount = availableEvents.filter((a) => a.storefrontVersion === "v2_dapper").length
      const v2FlowtyAvailCount = availableEvents.filter((a) => a.storefrontVersion === "v2_flowty").length
      const v1ComplCount = completedEvents.filter((c) => c.storefrontVersion === "v1").length
      const v2DapperComplCount = completedEvents.filter((c) => c.storefrontVersion === "v2_dapper").length
      const v2FlowtyComplCount = completedEvents.filter((c) => c.storefrontVersion === "v2_flowty").length
      rowsFound = availableEvents.length + completedEvents.length

      console.log(
        `[${PIPELINE_NAME}] range=${lastBlock + 1}-${targetHeight} ` +
          `v1Avail=${v1AvailCount} v2DapperAvail=${v2DapperAvailCount} v2FlowtyAvail=${v2FlowtyAvailCount} ` +
          `v1Compl=${v1ComplCount} v2DapperCompl=${v2DapperComplCount} v2FlowtyCompl=${v2FlowtyComplCount}`
      )

      const uniqueNftIds = [...new Set(availableEvents.map((a) => a.nftID))]
      const nftToEditionExternalId = new Map<string, string>()
      if (uniqueNftIds.length > 0) {
        for (let i = 0; i < uniqueNftIds.length; i += 500) {
          const batch = uniqueNftIds.slice(i, i + 500)
          const { data } = await (supabaseAdmin as any)
            .from("wallet_moments_cache")
            .select("moment_id, edition_key")
            .eq("collection_id", UFC_COLLECTION_ID)
            .in("moment_id", batch)
          for (const row of data ?? []) {
            if (row.edition_key) nftToEditionExternalId.set(row.moment_id, row.edition_key)
          }
        }
      }

      const editionExternalIds = [...new Set(nftToEditionExternalId.values())]
      const editionExternalIdToUuid = new Map<string, string>()
      if (editionExternalIds.length > 0) {
        for (let i = 0; i < editionExternalIds.length; i += 500) {
          const batch = editionExternalIds.slice(i, i + 500)
          const { data } = await (supabaseAdmin as any)
            .from("editions")
            .select("id, external_id")
            .eq("collection_id", UFC_COLLECTION_ID)
            .in("external_id", batch)
          for (const row of data ?? []) editionExternalIdToUuid.set(row.external_id, row.id)
        }
      }

      const v2Rows: any[] = []
      for (const a of availableEvents) {
        const editionExternalId = nftToEditionExternalId.get(a.nftID)
        const editionUuid = editionExternalId ? editionExternalIdToUuid.get(editionExternalId) ?? null : null
        if (!editionUuid && unresolvedSample.length < 20) unresolvedSample.push(a.nftID)

        const currency = deriveCurrency(a.salePaymentVaultType)
        const salePriceNum = parseFloat(a.salePrice) || 0
        const priceUsd = isUsdEquivalent(currency) ? salePriceNum : null

        v2Rows.push({
          listing_resource_id: a.listingResourceID,
          source: sourceFor(a.storefrontVersion),
          flow_id: a.nftID,
          edition_id: editionUuid,
          collection_id: UFC_COLLECTION_ID,
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
        const targetSource = sourceFor(c.storefrontVersion)
        const { data: updated, error: updErr } = await (supabaseAdmin as any)
          .from("cached_listings_v2")
          .update({ completed_at: c.blockTimestamp, completed_status: status })
          .eq("listing_resource_id", c.listingResourceID)
          .eq("source", targetSource)
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
        .eq("id", "ufc_listings")
      cursorAfter = String(targetHeight)

      extra.blocks_scanned = targetHeight - lastBlock
      extra.events_pre_filter =
        rawV1Avail + rawV1Compl + rawV2DapperAvail + rawV2DapperCompl + rawV2FlowtyAvail + rawV2FlowtyCompl
      extra.events_post_filter = rowsFound
      extra.v1_available_count = v1AvailCount
      extra.v1_completed_count = v1ComplCount
      extra.v2_dapper_available_count = v2DapperAvailCount
      extra.v2_dapper_completed_count = v2DapperComplCount
      extra.v2_dapper_typeids_seen = Array.from(v2DapperTypeIds).slice(0, 10)
      extra.v2_flowty_available_count = v2FlowtyAvailCount
      extra.v2_flowty_completed_count = v2FlowtyComplCount
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
