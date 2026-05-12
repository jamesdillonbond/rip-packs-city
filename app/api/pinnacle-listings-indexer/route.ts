import { NextRequest, NextResponse, after } from "next/server"
import * as Sentry from "@sentry/nextjs"
import { supabaseAdmin } from "@/lib/supabase"

// ── On-chain Disney Pinnacle listings indexer (cached_listings_v2 direct) ────
//
// Scans Dapper's standard NFTStorefrontV2 (0x4eb8a10cb9f87357) for
// ListingAvailable and ListingCompleted events filtered to Pinnacle.NFT
// (A.edf9df96c92f4595.Pinnacle.NFT). Writes source='direct' rows into
// cached_listings_v2 so they sit alongside the Flowty-sourced rows for the
// same divergence-reconciliation pipeline AllDay uses.
//
// Notes specific to Pinnacle:
//   • Pinnacle Cadence uses Int, not UInt64, for NFT IDs. Observed values
//     fit comfortably inside bigint (max ~10^14), so the cached_listings_v2
//     bigint columns are safe — we still pass them as strings via PostgREST
//     to avoid JS Number precision loss.
//   • Edition resolution: nftID → pinnacle_nft_map.edition_key → editions.id
//     (via external_id match scoped to the Pinnacle collection). The public
//     editions table has near-zero Pinnacle coverage today, so edition_id
//     will typically be NULL — per spec we still write the row.
//   • No FMV writes. pinnacle_fmv_snapshots is a separate sales-driven chain
//     and the listings-indexer stays out of it.
//   • No Cadence borrow fallback. Pinnacle's MetadataViews surface doesn't
//     expose ResolverCollection, and the pinnacle_nft_map/wmc backfill paths
//     populate the maps separately on their own cadence.
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const PINNACLE_COLLECTION_ID = "7dd9dd11-e8b6-45c4-ac99-71331f959714"
const COLLECTION_SLUG = "disney_pinnacle"
const PIPELINE_NAME = "pinnacle-listings-indexer"
const PINNACLE_NFT_TYPE_ID = "A.edf9df96c92f4595.Pinnacle.NFT"

const STOREFRONT_LISTING_AVAILABLE = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingAvailable"
const STOREFRONT_LISTING_COMPLETED = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted"
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
      case "Bool":
      case "String":
      case "Address":
      case "Path":
      case "Character":
        return value
      case "Int":
      case "UInt":
      case "Int8":
      case "Int16":
      case "Int32":
      case "Int64":
      case "Int128":
      case "Int256":
      case "UInt8":
      case "UInt16":
      case "UInt32":
      case "UInt64":
      case "UInt128":
      case "UInt256":
      case "Word8":
      case "Word16":
      case "Word32":
      case "Word64":
      case "Fix64":
      case "UFix64":
        return value
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
  block_id: string
  block_height: string
  block_timestamp: string
  events?: Array<{ type: string; transaction_id: string; payload: string; event_index: number }>
}

async function fetchEventRange(type: string, start: number, end: number): Promise<FlowEventBlock[]> {
  const url = `${FLOW_REST}/v1/events?type=${encodeURIComponent(type)}&start_height=${start}&end_height=${end}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) {
    console.log(
      `[pinnacle-listings-indexer] events ${start}-${end} ${type.split(".").pop()} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`
    )
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

// Dapper's stablecoin vaults (DUC, FUT) settle 1:1 against USD, so salePrice
// is already the USD figure. FLOW / FUSD denominated listings would require
// live FX which this pipeline does not perform — currency is tagged and
// price_usd is left null for those.
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
  blockHeight: number
  blockTimestamp: string
  txHash: string
  eventIndex: number
  listingResourceID: string
  purchased: boolean
}

export async function POST(req: NextRequest) {
  const start = Date.now()
  const startedAt = new Date(start).toISOString()

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
    let unresolvedEditionCount = 0
    const unresolvedSample: string[] = []

    try {
      const { data: cursorRow, error: cursorErr } = await (supabaseAdmin as any)
        .from("event_cursor")
        .select("last_processed_block")
        .eq("id", "pinnacle_listings")
        .single()

      if (cursorErr) {
        throw new Error(`cursor read error: ${cursorErr.message}`)
      }

      let lastBlock = Number(cursorRow?.last_processed_block ?? 0)
      const currentHeight = await getLatestSealedHeight()

      // First-run init: anchor cursor at sealed tip and exit. We only want
      // forward churn — no historical backscan. Subsequent ticks walk forward.
      if (lastBlock === 0) {
        await (supabaseAdmin as any)
          .from("event_cursor")
          .update({ last_processed_block: currentHeight, updated_at: new Date().toISOString() })
          .eq("id", "pinnacle_listings")
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

      console.log(
        `[pinnacle-listings-indexer] scanning ${lastBlock + 1} → ${targetHeight} (${targetHeight - lastBlock} blocks)`
      )

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
                if (!nftTypeId || !nftTypeId.includes("Pinnacle")) continue
                if (nftTypeId !== PINNACLE_NFT_TYPE_ID && !nftTypeId.includes(".Pinnacle.NFT")) continue

                const storefrontAddress =
                  typeof payload.storefrontAddress === "string" ? payload.storefrontAddress : null
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
                  expiry:
                    payload.expiry !== undefined && payload.expiry !== null
                      ? String(payload.expiry)
                      : undefined,
                })
              } catch (err) {
                console.log(
                  "[pinnacle-listings-indexer] available decode err:",
                  err instanceof Error ? err.message : String(err)
                )
              }
            }
          }

          for (const blk of complBlocks) {
            const bh = Number(blk.block_height)
            const bts = blk.block_timestamp
            for (const evt of blk.events ?? []) {
              rawCompleted++
              try {
                const raw = JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))
                const payload = unwrapCdc(raw) as Record<string, any>
                const nftTypeId = extractTypeId(payload?.nftType)
                if (!nftTypeId || !nftTypeId.includes("Pinnacle")) continue
                if (nftTypeId !== PINNACLE_NFT_TYPE_ID && !nftTypeId.includes(".Pinnacle.NFT")) continue

                completedEvents.push({
                  blockHeight: bh,
                  blockTimestamp: bts,
                  txHash: evt.transaction_id,
                  eventIndex: evt.event_index,
                  listingResourceID: String(payload.listingResourceID),
                  purchased: payload.purchased === true,
                })
              } catch (err) {
                console.log(
                  "[pinnacle-listings-indexer] completed decode err:",
                  err instanceof Error ? err.message : String(err)
                )
              }
            }
          }
        } catch (err) {
          console.log(
            `[pinnacle-listings-indexer] chunk ${s}-${e} error:`,
            err instanceof Error ? err.message : String(err)
          )
        }
        if (s + CHUNK_SIZE <= targetHeight) await delay(INTER_CHUNK_DELAY_MS)
      }

      listingsAvailableCount = availableEvents.length
      listingsCompletedCount = completedEvents.length
      rowsFound = listingsAvailableCount + listingsCompletedCount

      console.log(
        `[pinnacle-listings-indexer] range=${lastBlock + 1}-${targetHeight} rawAvail=${rawAvailable} rawCompl=${rawCompleted} availFiltered=${listingsAvailableCount} complFiltered=${listingsCompletedCount}`
      )

      // ── Resolve nftID → editions UUID via pinnacle_nft_map + editions ──────
      // Pinnacle has no Cadence borrow fallback exposed today; if the maps
      // miss, we still write the listing row with edition_id NULL so the
      // pricing surface isn't blocked on the metadata pipeline. The
      // pinnacle_nft_map cron + wmc backfill independently fill these gaps.
      const uniqueNftIds = [...new Set(availableEvents.map((a) => a.nftID))]
      const nftToEditionKey = new Map<string, string>()

      if (uniqueNftIds.length > 0) {
        for (let i = 0; i < uniqueNftIds.length; i += 500) {
          const batch = uniqueNftIds.slice(i, i + 500)
          const { data } = await (supabaseAdmin as any)
            .from("pinnacle_nft_map")
            .select("nft_id, edition_key")
            .in("nft_id", batch)
          for (const row of data ?? []) {
            if (row.edition_key) nftToEditionKey.set(String(row.nft_id), String(row.edition_key))
          }
        }

        // Fallback to wmc for any nftIDs the pinnacle_nft_map missed.
        const stillMissing = uniqueNftIds.filter((id) => !nftToEditionKey.has(id))
        if (stillMissing.length > 0) {
          for (let i = 0; i < stillMissing.length; i += 500) {
            const batch = stillMissing.slice(i, i + 500)
            const { data } = await (supabaseAdmin as any)
              .from("wallet_moments_cache")
              .select("moment_id, edition_key")
              .eq("collection_id", PINNACLE_COLLECTION_ID)
              .in("moment_id", batch)
            for (const row of data ?? []) {
              if (row.edition_key) nftToEditionKey.set(String(row.moment_id), String(row.edition_key))
            }
          }
        }
      }

      const editionKeys = [...new Set(nftToEditionKey.values())]
      const editionKeyToUuid = new Map<string, string>()
      if (editionKeys.length > 0) {
        for (let i = 0; i < editionKeys.length; i += 500) {
          const batch = editionKeys.slice(i, i + 500)
          const { data } = await (supabaseAdmin as any)
            .from("editions")
            .select("id, external_id")
            .eq("collection_id", PINNACLE_COLLECTION_ID)
            .in("external_id", batch)
          for (const row of data ?? []) editionKeyToUuid.set(row.external_id, row.id)
        }
      }

      // ── Build cached_listings_v2 upsert rows ───────────────────────────────
      const v2Rows: any[] = []
      for (const a of availableEvents) {
        const editionKey = nftToEditionKey.get(a.nftID)
        const editionUuid = editionKey ? editionKeyToUuid.get(editionKey) : null

        if (!editionUuid) {
          unresolvedEditionCount++
          if (unresolvedSample.length < 20) unresolvedSample.push(a.nftID)
          // Per spec: write the row anyway with edition_id null.
        }

        const currency = deriveCurrency(a.salePaymentVaultType)
        const salePriceNum = parseFloat(a.salePrice) || 0
        const priceUsd = isUsdEquivalent(currency) ? salePriceNum : null

        v2Rows.push({
          listing_resource_id: a.listingResourceID,
          source: "direct",
          flow_id: a.nftID,
          edition_id: editionUuid ?? null,
          collection_id: PINNACLE_COLLECTION_ID,
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
          console.log("[pinnacle-listings-indexer] v2 upsert err:", error.message)
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

      // Soft-completion: mark matching direct rows as purchased/cancelled.
      // No-op when no matching listing_resource_id exists yet (dual-run window
      // before the corresponding ListingAvailable was observed).
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
          console.log(
            `[pinnacle-listings-indexer] complete update err lrid=${c.listingResourceID}:`,
            updErr.message
          )
          continue
        }
        if (updated && updated.length > 0) completedMatched++
        else completedSkipped++
      }

      await (supabaseAdmin as any)
        .from("event_cursor")
        .update({ last_processed_block: targetHeight, updated_at: new Date().toISOString() })
        .eq("id", "pinnacle_listings")
      cursorAfter = String(targetHeight)

      extra.blocks_scanned = targetHeight - lastBlock
      extra.events_pre_filter = rawAvailable + rawCompleted
      extra.events_post_filter = rowsFound
      extra.events_filtered_to_pinnacle = listingsAvailableCount + listingsCompletedCount
      extra.listings_available_count = listingsAvailableCount
      extra.listings_completed_count = listingsCompletedCount
      extra.completed_matched = completedMatched
      extra.completed_unmatched = completedSkipped
      extra.unresolved_edition_count = unresolvedEditionCount
      extra.unresolved_sample = unresolvedSample
      extra.elapsed_ms = Date.now() - start

      if (unresolvedEditionCount > 0) {
        Sentry.addBreadcrumb({
          category: "pinnacle-listings-indexer",
          level: "info",
          message: "pinnacle_listings_unresolved_editions",
          data: {
            unresolved: unresolvedEditionCount,
            total: listingsAvailableCount,
            first_5: unresolvedSample.slice(0, 5),
          },
        })
      }
    } catch (err) {
      ok = false
      errorMsg = err instanceof Error ? err.message : String(err)
      console.log(`[pinnacle-listings-indexer] fatal:`, errorMsg)
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
        console.log(
          `[pinnacle-listings-indexer] log_pipeline_run err:`,
          e instanceof Error ? e.message : String(e)
        )
      }
    }
  })

  return NextResponse.json({ ok: true, message: "indexing started" })
}

export async function GET(req: NextRequest) {
  return POST(req)
}
