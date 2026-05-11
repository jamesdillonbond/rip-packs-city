import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── On-chain NFL All Day listings indexer (dual-run direct source) ───────────
//
// Scans Flowty's NFTStorefrontV2 fork (0x3cdbb3d569211ff3) for ListingAvailable
// (new listings) and ListingCompleted (purchased=true OR purchased=false →
// cancelled). Filters to AllDay nftType, resolves nftID → editions UUID via
// wallet_moments_cache (with a Cadence borrow fallback against the seller
// wallet), and writes rows into cached_listings_v2 with source='direct' so
// they can coexist with source='flowty' rows for divergence reconciliation.
//
// First run initializes the cursor at the current sealed block height — no
// historical backscan. Subsequent cron ticks walk forward. The 137,390,146
// spork boundary is therefore never crossed in practice, so this route hits
// rest-mainnet.onflow.org directly without a spork-proxy branch.
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const COLLECTION_SLUG = "nfl_all_day"
const PIPELINE_NAME = "allday-listings-indexer"
const ALLDAY_NFT_TYPE_ID = "A.e4cf4bdc1751c65d.AllDay.NFT"

const STOREFRONT_LISTING_AVAILABLE = "A.3cdbb3d569211ff3.NFTStorefrontV2.ListingAvailable"
const STOREFRONT_LISTING_COMPLETED = "A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted"
const FLOW_REST = "https://rest-mainnet.onflow.org"
const CHUNK_SIZE = 250
const DEFAULT_SCAN_RANGE = 50_000
const MAX_SCAN_RANGE = 100_000
const INTER_CHUNK_DELAY_MS = 75
const CADENCE_FALLBACK_MAX = 12
const CADENCE_DELAY_MS = 150
const SCRIPT_TIMEOUT_MS = 15_000

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
    console.log(`[allday-listings-indexer] events ${start}-${end} ${type.split(".").pop()} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
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

// Seller-side AllDay-typed borrow. Mirrors the buyer-side borrow in
// allday-sales-indexer but targets the seller's address, since for an active
// listing the seller still holds the NFT in their AllDay collection (Flowty's
// storefront uses capability-based listings, not escrow). Returns nil if the
// seller doesn't hold the NFT (e.g. cancelled and moved before we read), in
// which case we skip the row.
const BORROW_MOMENT_SCRIPT = `
import AllDay from 0xe4cf4bdc1751c65d
access(all) fun main(seller: Address, id: UInt64): {String: String}? {
  let col = getAccount(seller).capabilities.borrow<&AllDay.Collection>(/public/AllDayNFTCollection)
  if col == nil { return nil }
  let nft = col!.borrowMomentNFT(id: id)
  if nft == nil { return nil }
  return {
    "id": nft!.id.toString(),
    "editionID": nft!.editionID.toString(),
    "serialNumber": nft!.serialNumber.toString()
  }
}
`

async function runScript(code: string, args: Array<{ type: string; value: unknown }>): Promise<unknown> {
  const body = {
    script: Buffer.from(code, "utf8").toString("base64"),
    arguments: args.map((a) => Buffer.from(JSON.stringify(a), "utf8").toString("base64")),
  }
  const res = await fetch(`${FLOW_REST}/v1/scripts?block_height=sealed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SCRIPT_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`script HTTP ${res.status}`)
  const json = (await res.json()) as { value?: string } | string
  let raw: string
  if (typeof json === "string") raw = json
  else raw = String(json.value ?? "")
  if (!raw) return null
  const trimmed = raw.trim().replace(/^"|"$/g, "")
  const decoded = JSON.parse(Buffer.from(trimmed, "base64").toString("utf8"))
  return unwrapCdc(decoded)
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

// Dapper utility coins are minted 1:1 against USD in production, so salePrice
// in those vaults is already the USD figure. FLOW / FUSD denominated listings
// require live FX, which this pipeline does not perform — store currency tag
// + raw price metadata via custom_id and leave price_usd null for those.
function isUsdEquivalent(currency: string): boolean {
  return currency === "DUC" || currency === "FUT"
}

// Flowty's expiry field on ListingAvailable is `expiry: UInt64` — Unix epoch
// seconds. Convert to ISO timestamp; treat zero / unset as no expiry.
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
    let cadenceAttempted = 0
    let cadenceResolved = 0
    const unresolvedSample: string[] = []

    try {
      const { data: cursorRow, error: cursorErr } = await (supabaseAdmin as any)
        .from("event_cursor")
        .select("last_processed_block")
        .eq("id", "allday_listings")
        .single()

      if (cursorErr) {
        throw new Error(`cursor read error: ${cursorErr.message}`)
      }

      let lastBlock = Number(cursorRow?.last_processed_block ?? 0)
      const currentHeight = await getLatestSealedHeight()

      // First-run init: anchor the cursor at the current sealed height and
      // exit. No historical backscan — we only care about listing churn from
      // ship-time forward. Subsequent ticks walk forward from here.
      if (lastBlock === 0) {
        await (supabaseAdmin as any)
          .from("event_cursor")
          .update({ last_processed_block: currentHeight, updated_at: new Date().toISOString() })
          .eq("id", "allday_listings")
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
        `[allday-listings-indexer] scanning ${lastBlock + 1} → ${targetHeight} (${targetHeight - lastBlock} blocks)`
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
                if (!nftTypeId || !nftTypeId.includes("AllDay")) continue
                if (nftTypeId !== ALLDAY_NFT_TYPE_ID && !nftTypeId.includes(".AllDay.NFT")) continue

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
                  expiry: payload.expiry !== undefined && payload.expiry !== null ? String(payload.expiry) : undefined,
                })
              } catch (err) {
                console.log(
                  "[allday-listings-indexer] available decode err:",
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
                if (!nftTypeId || !nftTypeId.includes("AllDay")) continue
                if (nftTypeId !== ALLDAY_NFT_TYPE_ID && !nftTypeId.includes(".AllDay.NFT")) continue

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
                  "[allday-listings-indexer] completed decode err:",
                  err instanceof Error ? err.message : String(err)
                )
              }
            }
          }
        } catch (err) {
          console.log(
            `[allday-listings-indexer] chunk ${s}-${e} error:`,
            err instanceof Error ? err.message : String(err)
          )
        }
        if (s + CHUNK_SIZE <= targetHeight) await delay(INTER_CHUNK_DELAY_MS)
      }

      listingsAvailableCount = availableEvents.length
      listingsCompletedCount = completedEvents.length
      rowsFound = listingsAvailableCount + listingsCompletedCount

      console.log(
        `[allday-listings-indexer] range=${lastBlock + 1}-${targetHeight} rawAvail=${rawAvailable} rawCompl=${rawCompleted} availFiltered=${listingsAvailableCount} complFiltered=${listingsCompletedCount}`
      )

      // ── Resolve nftID → editions UUID for ListingAvailable events ──────────
      const uniqueNftIds = [...new Set(availableEvents.map((a) => a.nftID))]
      const nftToEditionExternalId = new Map<string, string>()

      if (uniqueNftIds.length > 0) {
        for (let i = 0; i < uniqueNftIds.length; i += 500) {
          const batch = uniqueNftIds.slice(i, i + 500)
          const { data } = await (supabaseAdmin as any)
            .from("wallet_moments_cache")
            .select("moment_id, edition_key")
            .eq("collection_id", ALLDAY_COLLECTION_ID)
            .in("moment_id", batch)
          for (const row of data ?? []) {
            if (row.edition_key) nftToEditionExternalId.set(row.moment_id, row.edition_key)
          }
        }

        // nft_edition_map (populated by sales-indexer's resolver) is a richer
        // source than wmc for hot nfts that have been sold — check it for any
        // residual misses before falling back to Cadence.
        const stillMissing = uniqueNftIds.filter((id) => !nftToEditionExternalId.has(id))
        if (stillMissing.length > 0) {
          for (let i = 0; i < stillMissing.length; i += 500) {
            const batch = stillMissing.slice(i, i + 500)
            const { data } = await (supabaseAdmin as any)
              .from("nft_edition_map")
              .select("nft_id, edition_external_id")
              .eq("collection_id", ALLDAY_COLLECTION_ID)
              .in("nft_id", batch)
            for (const row of data ?? []) {
              if (row.edition_external_id) nftToEditionExternalId.set(row.nft_id, row.edition_external_id)
            }
          }
        }
      }

      // Cadence fallback against seller wallet for nftIDs the cache missed.
      const seenSeller = new Set<string>()
      for (const a of availableEvents) {
        if (cadenceAttempted >= CADENCE_FALLBACK_MAX) break
        if (nftToEditionExternalId.has(a.nftID)) continue
        if (seenSeller.has(a.nftID)) continue
        seenSeller.add(a.nftID)
        cadenceAttempted++

        try {
          const result = (await runScript(BORROW_MOMENT_SCRIPT, [
            { type: "Address", value: a.storefrontAddress },
            { type: "UInt64", value: a.nftID },
          ])) as Record<string, string> | null
          if (result && typeof result === "object" && result.editionID) {
            nftToEditionExternalId.set(a.nftID, String(result.editionID))
            cadenceResolved++
          }
        } catch (err) {
          console.log(
            `[allday-listings-indexer] borrow err nft=${a.nftID} seller=${a.storefrontAddress}:`,
            err instanceof Error ? err.message : String(err)
          )
        }
        await delay(CADENCE_DELAY_MS)
      }

      // Resolve edition_external_id → editions.id (UUID).
      const editionExternalIds = [...new Set(nftToEditionExternalId.values())]
      const editionExternalIdToUuid = new Map<string, string>()
      if (editionExternalIds.length > 0) {
        for (let i = 0; i < editionExternalIds.length; i += 500) {
          const batch = editionExternalIds.slice(i, i + 500)
          const { data } = await (supabaseAdmin as any)
            .from("editions")
            .select("id, external_id")
            .eq("collection_id", ALLDAY_COLLECTION_ID)
            .in("external_id", batch)
          for (const row of data ?? []) editionExternalIdToUuid.set(row.external_id, row.id)
        }
      }

      // ── Build cached_listings_v2 upsert rows ────────────────────────────────
      const v2Rows: any[] = []
      const failuresToQueue: any[] = []
      for (const a of availableEvents) {
        const editionExternalId = nftToEditionExternalId.get(a.nftID)
        const editionUuid = editionExternalId ? editionExternalIdToUuid.get(editionExternalId) : null

        if (!editionUuid) {
          if (unresolvedSample.length < 20) unresolvedSample.push(a.nftID)
          rowsSkipped++
          // Capture the full event payload into the retry queue. The /15
          // retry cron pulls these with a bumped CADENCE_FALLBACK_MAX (32)
          // and replays the resolution. See docs/audits/listing-divergence-2026-05.md.
          const reason = editionExternalId
            ? "edition_external_id_not_in_editions_table"
            : cadenceAttempted >= CADENCE_FALLBACK_MAX
              ? "cadence_fallback_cap_hit"
              : "wmc_miss_no_seller_cadence_attempt"
          failuresToQueue.push({
            collection_id: ALLDAY_COLLECTION_ID,
            flow_id: a.nftID,
            listing_resource_id: a.listingResourceID,
            event_payload: a,
            failure_reason: reason,
          })
          continue
        }

        const currency = deriveCurrency(a.salePaymentVaultType)
        const salePriceNum = parseFloat(a.salePrice) || 0
        const priceUsd = isUsdEquivalent(currency) ? salePriceNum : null

        v2Rows.push({
          listing_resource_id: a.listingResourceID,
          source: "direct",
          flow_id: a.nftID,
          edition_id: editionUuid,
          collection_id: ALLDAY_COLLECTION_ID,
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

      // Insert ListingAvailable rows.
      for (let i = 0; i < v2Rows.length; i += 100) {
        const batch = v2Rows.slice(i, i + 100)
        const { error } = await (supabaseAdmin as any)
          .from("cached_listings_v2")
          .upsert(batch, { onConflict: "listing_resource_id,source", ignoreDuplicates: false })
        if (error) {
          console.log("[allday-listings-indexer] v2 upsert err:", error.message)
          for (const row of batch) {
            const { error: se } = await (supabaseAdmin as any)
              .from("cached_listings_v2")
              .upsert(row, { onConflict: "listing_resource_id,source", ignoreDuplicates: false })
            if (!se) rowsWritten++
          }
        } else {
          rowsWritten += batch.length
        }
      }

      // Persist failed resolutions to listing_resolution_failures so the
      // /api/allday-listings-retry */15 cron can drain them with a bumped
      // Cadence cap. Upsert by (collection_id, listing_resource_id) so a
      // re-observation just refreshes the row instead of duplicating it.
      let queuedFailures = 0
      if (failuresToQueue.length > 0) {
        for (let i = 0; i < failuresToQueue.length; i += 100) {
          const batch = failuresToQueue.slice(i, i + 100)
          const { error } = await (supabaseAdmin as any)
            .from("listing_resolution_failures")
            .upsert(batch, { onConflict: "collection_id,listing_resource_id", ignoreDuplicates: true })
          if (error) {
            console.log("[allday-listings-indexer] failure-queue upsert err:", error.message)
          } else {
            queuedFailures += batch.length
          }
        }
      }
      extra.queued_failures = queuedFailures

      // Soft-mark ListingCompleted updates against existing direct rows. If no
      // matching row exists (we missed the corresponding ListingAvailable),
      // .update is a no-op which is the correct behaviour during dual-run.
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
            `[allday-listings-indexer] complete update err lrid=${c.listingResourceID}:`,
            updErr.message
          )
          continue
        }
        if (updated && updated.length > 0) completedMatched++
        else completedSkipped++
      }

      // Advance cursor.
      await (supabaseAdmin as any)
        .from("event_cursor")
        .update({ last_processed_block: targetHeight, updated_at: new Date().toISOString() })
        .eq("id", "allday_listings")
      cursorAfter = String(targetHeight)

      extra.blocks_scanned = targetHeight - lastBlock
      // events_pre_filter / events_post_filter ratio surfaces over-aggressive
      // nftType filtering — most NFTStorefrontV2 traffic on 0x3cdbb3d569211ff3
      // is Top Shot, so a tiny ratio is normal; ratio = 0 with non-zero
      // pre-filter means the AllDay nftType match is rejecting everything.
      extra.events_pre_filter = rawAvailable + rawCompleted
      extra.events_post_filter = rowsFound
      extra.events_filtered_to_allday = listingsAvailableCount + listingsCompletedCount
      extra.listings_available_count = listingsAvailableCount
      extra.listings_completed_count = listingsCompletedCount
      extra.completed_matched = completedMatched
      extra.completed_unmatched = completedSkipped
      extra.cadence_attempted = cadenceAttempted
      extra.cadence_resolved = cadenceResolved
      extra.unresolved_sample = unresolvedSample
      extra.elapsed_ms = Date.now() - start
    } catch (err) {
      ok = false
      errorMsg = err instanceof Error ? err.message : String(err)
      console.log(`[allday-listings-indexer] fatal:`, errorMsg)
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
          `[allday-listings-indexer] log_pipeline_run err:`,
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
