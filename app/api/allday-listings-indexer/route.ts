import { NextRequest, NextResponse, after } from "next/server"
import * as Sentry from "@sentry/nextjs"
import { supabaseAdmin } from "@/lib/supabase"

// ── On-chain NFL All Day listings indexer (triple storefront scan) ───────────
//
// Scans SIX event types per tick under a single cursor:
//
//   V1 Dapper: A.4eb8a10cb9f87357.NFTStorefront — original Dapper-deployed
//     storefront. ListingAvailable payload carries `storefrontAddress /
//     listingResourceID / nftType / nftID / ftVaultType (Type) / price
//     (UFix64)` — full pricing inline, no aux fetch needed. ListingCompleted
//     carries `listingResourceID / storefrontResourceID / purchased / nftType
//     / nftID` (reduced).
//
//   V2 Dapper: A.4eb8a10cb9f87357.NFTStorefrontV2 — in production traffic
//     this carries TopShot PackNFT / Pinnacle / MFL pack listings, not
//     AllDay moments (diagnostic-confirmed 2026-05-18 via
//     `v2_dapper_typeids_seen`). Branch kept armed because it is zero-cost
//     and the per-tick typeid roster surfaces any future venue shift.
//     ListingAvailable carries `salePrice / salePaymentVaultType / customID
//     / expiry` inline plus the V1-style identity fields.
//
//   V2 Flowty: A.3cdbb3d569211ff3.NFTStorefrontV2 — dormant since 2026-05-14
//     but kept for the cancellation tail.
//
// V1 chain rows land in cached_listings_v2 with source='direct_v1'; V2 Dapper
// with source='direct_v2'; V2 Flowty with source='direct' (legacy). The three
// share the listing_resource_id space without collision because resource UUIDs
// are globally unique across Flow contracts.
//
// First run anchors cursor at sealed tip — no historical backscan. Subsequent
// ticks walk forward up to MAX_SCAN_RANGE.
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const COLLECTION_SLUG = "nfl_all_day"
const PIPELINE_NAME = "allday-listings-indexer"
const ALLDAY_NFT_TYPE_SUFFIX = ".AllDay.NFT"

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
const CADENCE_FALLBACK_MAX = 12
const CADENCE_DELAY_MS = 150
const SCRIPT_TIMEOUT_MS = 15_000

// Sentry spike threshold: only page when an ABNORMAL number of genuinely-new
// resolution failures land in a single indexer tick. AllDay has a permanent
// unresolvable tail (a few new unmapped listings most ticks), so firing on
// every tick with >=1 new failure was structural noise. A spike this large in
// one tick means something upstream changed and is worth a page. Mirrors the
// pinnacle indexer's gate (commit 48f5a98).
const SENTRY_SPIKE_THRESHOLD = 25

// Failure reasons that are part of AllDay's expected, permanent unresolvable
// tail — logged to pipeline_runs for trend visibility but NOT worth a Sentry
// page on their own. Any reason OUTSIDE this set is an unexpected/new code path
// (a regression) and DOES page regardless of volume.
const EXPECTED_FAILURE_REASONS = new Set([
  "edition_external_id_not_in_editions_table",
  "cadence_fallback_cap_hit",
  "wmc_miss_no_seller_cadence_attempt",
])

// Of the expected reasons, these are SELF-RESOLVING retry-queue churn: the
// per-tick Cadence fallback budget was exhausted, or a listing arrived before
// the seller's wmc row — both resolve on a later tick (observed 2026-06-13:
// ~98% resolve; only a handful ever stay unresolved). A busy listing wave
// queues a BURST of these in one tick, which is throughput, not an upstream
// regression — so they must NOT count toward the Sentry spike that pages
// (this burst was reopening NEXTJS-15). A spike of a genuinely-unresolvable
// reason (e.g. edition_external_id_not_in_editions_table = a keying/seed
// regression) still counts and still pages.
const TRANSIENT_FAILURE_REASONS = new Set([
  "cadence_fallback_cap_hit",
  "wmc_miss_no_seller_cadence_attempt",
])

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
  blockHeight: number
  blockTimestamp: string
  txHash: string
  eventIndex: number
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

      console.log(`[allday-listings-indexer] scanning ${lastBlock + 1} → ${targetHeight} (${targetHeight - lastBlock} blocks)`)

      const availableEvents: ListingAvailableEvent[] = []
      const completedEvents: ListingCompletedEvent[] = []
      let rawV1Avail = 0
      let rawV1Compl = 0
      let rawV2DapperAvail = 0
      let rawV2DapperCompl = 0
      let rawV2FlowtyAvail = 0
      let rawV2FlowtyCompl = 0
      // Track distinct V2 Dapper nftTypeIds observed per tick. As of 2026-05-18
      // V2 Dapper carries MFLPack.NFT / Pinnacle.NFT / TopShot PackNFT.NFT only;
      // a future shift that surfaces .AllDay.NFT here would flag a venue change.
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

          const processAvailable = (blocks: FlowEventBlock[], version: StorefrontVersion, rawIncr: () => void) => {
            for (const blk of blocks) {
              const bh = Number(blk.block_height)
              const bts = blk.block_timestamp
              for (const evt of blk.events ?? []) {
                rawIncr()
                try {
                  const raw = JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))
                  const payload = unwrapCdc(raw) as Record<string, any>
                  const nftTypeId = extractTypeId(payload?.nftType)
                  if (version === "v2_dapper" && nftTypeId) v2DapperTypeIds.add(nftTypeId)
                  if (!nftTypeId || !nftTypeId.endsWith(ALLDAY_NFT_TYPE_SUFFIX)) continue

                  const storefrontAddress =
                    typeof payload.storefrontAddress === "string" ? payload.storefrontAddress : null
                  if (!storefrontAddress) continue

                  // V1 emits `price` (UFix64); V2 emits `salePrice`. Both
                  // emit `ftVaultType` for V1 and `salePaymentVaultType` for V2.
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
                  console.log("[allday-listings-indexer] available decode err:", err instanceof Error ? err.message : String(err))
                }
              }
            }
          }

          const processCompleted = (blocks: FlowEventBlock[], version: StorefrontVersion, rawIncr: () => void) => {
            for (const blk of blocks) {
              const bh = Number(blk.block_height)
              const bts = blk.block_timestamp
              for (const evt of blk.events ?? []) {
                rawIncr()
                try {
                  const raw = JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))
                  const payload = unwrapCdc(raw) as Record<string, any>
                  const nftTypeId = extractTypeId(payload?.nftType)
                  if (version === "v2_dapper" && nftTypeId) v2DapperTypeIds.add(nftTypeId)
                  if (!nftTypeId || !nftTypeId.endsWith(ALLDAY_NFT_TYPE_SUFFIX)) continue

                  completedEvents.push({
                    storefrontVersion: version,
                    blockHeight: bh,
                    blockTimestamp: bts,
                    txHash: evt.transaction_id,
                    eventIndex: evt.event_index,
                    listingResourceID: String(payload.listingResourceID),
                    purchased: payload.purchased === true,
                  })
                } catch (err) {
                  console.log("[allday-listings-indexer] completed decode err:", err instanceof Error ? err.message : String(err))
                }
              }
            }
          }

          processAvailable(v1AvailBlocks, "v1", () => rawV1Avail++)
          processCompleted(v1ComplBlocks, "v1", () => rawV1Compl++)
          processAvailable(v2DapperAvailBlocks, "v2_dapper", () => rawV2DapperAvail++)
          processCompleted(v2DapperComplBlocks, "v2_dapper", () => rawV2DapperCompl++)
          processAvailable(v2FlowtyAvailBlocks, "v2_flowty", () => rawV2FlowtyAvail++)
          processCompleted(v2FlowtyComplBlocks, "v2_flowty", () => rawV2FlowtyCompl++)
        } catch (err) {
          console.log(`[allday-listings-indexer] chunk ${s}-${e} error:`, err instanceof Error ? err.message : String(err))
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
        `[allday-listings-indexer] range=${lastBlock + 1}-${targetHeight} ` +
          `rawV1Avail=${rawV1Avail} rawV1Compl=${rawV1Compl} ` +
          `rawV2DapperAvail=${rawV2DapperAvail} rawV2DapperCompl=${rawV2DapperCompl} ` +
          `rawV2FlowtyAvail=${rawV2FlowtyAvail} rawV2FlowtyCompl=${rawV2FlowtyCompl} ` +
          `v1Avail=${v1AvailCount} v2DapperAvail=${v2DapperAvailCount} v2FlowtyAvail=${v2FlowtyAvailCount} ` +
          `v1Compl=${v1ComplCount} v2DapperCompl=${v2DapperComplCount} v2FlowtyCompl=${v2FlowtyComplCount}`
      )

      // ── Edition resolution (shared across V1 + V2 availables) ──────────────
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

      // ── Build cached_listings_v2 upserts ───────────────────────────────────
      const v2Rows: any[] = []
      const failuresToQueue: any[] = []
      for (const a of availableEvents) {
        const editionExternalId = nftToEditionExternalId.get(a.nftID)
        const editionUuid = editionExternalId ? editionExternalIdToUuid.get(editionExternalId) : null

        if (!editionUuid) {
          if (unresolvedSample.length < 20) unresolvedSample.push(a.nftID)
          rowsSkipped++
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
          source: sourceFor(a.storefrontVersion),
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

      let queuedFailures = 0
      const failureReasonCounts: Record<string, number> = {}
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
            for (const row of batch) {
              const reason = String(row.failure_reason)
              failureReasonCounts[reason] = (failureReasonCounts[reason] ?? 0) + 1
              Sentry.addBreadcrumb({
                category: "listing-retry",
                level: "warning",
                message: "listing_resolution_failure_inserted",
                data: {
                  collection: "nfl_all_day",
                  flow_id: String(row.flow_id),
                  failure_reason: reason,
                  listing_resource_id: String(row.listing_resource_id),
                },
              })
            }
          }
        }
        // Sentry: per-row breadcrumbs already emitted on queue insert above. This
        // summary captureMessage is the searchable dashboard event — but it is
        // RATE/REASON-gated, not per-tick. We page only on a real spike OR a
        // never-before-seen reason (a regression / new code path); the expected
        // steady-state tail logs to pipeline_runs but does not page. (commit 48f5a98)
        const hasUnexpectedReason = Object.keys(failureReasonCounts).some(
          (r) => !EXPECTED_FAILURE_REASONS.has(r)
        )
        // Spike count EXCLUDES self-resolving transient reasons — a wave of
        // cap-hit/timing requeues is not a regression and should not page.
        const pageableFailures = Object.entries(failureReasonCounts)
          .filter(([r]) => !TRANSIENT_FAILURE_REASONS.has(r))
          .reduce((n, [, c]) => n + (c as number), 0)
        if (pageableFailures > SENTRY_SPIKE_THRESHOLD || hasUnexpectedReason) {
          Sentry.captureMessage("listing_resolution_failures_inserted", {
            level: "warning",
            tags: {
              collection: "nfl_all_day",
              indexer: "allday-listings-indexer",
            },
            extra: {
              queued_failures: queuedFailures,
              pageable_failures: pageableFailures,
              failure_reason_counts: failureReasonCounts,
              unexpected_reason: hasUnexpectedReason,
              first_5_flow_ids: failuresToQueue.slice(0, 5).map((r) => String(r.flow_id)),
            },
          })
        }
      }
      extra.queued_failures = queuedFailures
      extra.failure_reason_counts = failureReasonCounts

      // ── Cancellation marking (V1 + V2 separately, source-scoped) ───────────
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
          console.log(
            `[allday-listings-indexer] complete update err lrid=${c.listingResourceID}:`,
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
        .eq("id", "allday_listings")
      cursorAfter = String(targetHeight)

      extra.blocks_scanned = targetHeight - lastBlock
      extra.events_pre_filter =
        rawV1Avail + rawV1Compl + rawV2DapperAvail + rawV2DapperCompl + rawV2FlowtyAvail + rawV2FlowtyCompl
      extra.events_post_filter = rowsFound
      extra.v1_available_count = v1AvailCount
      extra.v1_completed_count = v1ComplCount
      extra.v2_dapper_available_count = v2DapperAvailCount
      extra.v2_dapper_completed_count = v2DapperComplCount
      extra.v2_flowty_available_count = v2FlowtyAvailCount
      extra.v2_flowty_completed_count = v2FlowtyComplCount
      extra.v2_dapper_typeids_seen = Array.from(v2DapperTypeIds).slice(0, 10)
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
