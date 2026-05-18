import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { fireNextPipelineStep, fireSupabaseEdgeFunction } from "@/lib/pipeline-chain"
import { hydrateAllDayEditions, toUpsertRow } from "@/lib/editions-hydrate"
import { decodeV1SaleTx } from "@/lib/dapper-v1-tx-decode"
import crypto from "crypto"

// ── On-chain NFL All Day sales indexer ───────────────────────────────────────
//
// Scans TWO storefront contracts per tick under a single cursor:
//
//   V1 (primary, A.4eb8a10cb9f87357.NFTStorefront) — the original Dapper-
//     deployed storefront that AllDay (Golazos, UFC Strike) native sales have
//     always routed through. Its ListingCompleted payload is REDUCED
//     (listingResourceID / storefrontResourceID / purchased / nftType / nftID)
//     — no buyer, seller, or price. Those must be recovered from the tx's
//     auxiliary events (AllDay.Deposit.to / AllDay.Withdraw.from / DUC
//     TokensWithdrawn). Pre-2026-05-17 we mistakenly indexed only V2 (Flowty
//     fork) and missed every native AllDay sale; the JJLSmith $2,999 Marquee
//     Ultimate trace on Flowscan surfaced the V1 contract.
//
//   V2 (legacy, A.3cdbb3d569211ff3.NFTStorefrontV2) — Flowty's NFTStorefrontV2
//     fork. Dormant since 2026-05-14 but kept in the scan so cancellations
//     still land. V2 ListingCompleted DOES carry buyer/seller/price inline.
//
// Both event types live in the same block range, so one cursor on
// event_cursor.id='allday_sales' advances both — splitting would double the
// cron infrastructure for no operational benefit.
//
// Price-resolution chain for V1 sales:
//   1. Try cached_listings_v2 lookup by listing_resource_id (the listings-
//      indexer populates this from ListingAvailable's inline price field).
//   2. Fall back to decodeV1SaleTx, which fetches the tx and sums DUC
//      TokensWithdrawn from the DUC contract address `0xead892083b3e2c6c`.
//      A sanity check (split amounts must sum to gross within 1¢) flags
//      uncertain extractions — those route to unmapped_sales with a
//      resolution_hint rather than recording a guessed price.
//
// Edition resolution (wmc → Cadence borrow → AllDay GQL relay → on-chain
// getEditionData) is unchanged from the pre-V1 implementation.
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const COLLECTION_SLUG = "nfl_all_day"
const PIPELINE_NAME = "allday-sales-indexer"
const RESOLVER_PIPELINE_NAME = "allday-edition-resolver"

// V1 Dapper NFTStorefront — primary path for AllDay native sales.
const V1_LISTING_COMPLETED = "A.4eb8a10cb9f87357.NFTStorefront.ListingCompleted"
// V2 Flowty fork — dormant but kept for cancellation tail. `nftType` payload
// shape differs from V1 (V2 also emits a Type wrapper, but its other fields
// are richer — buyer, seller, salePrice all inline).
const V2_LISTING_COMPLETED = "A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted"

// Use endsWith() instead of includes() — A.e4cf4bdc1751c65d.PackNFT.NFT lives
// at the same address but is a separate contract; a .includes("AllDay") guard
// would not catch a future "AllDayBundle.NFT" variant either.
const ALLDAY_NFT_TYPE_SUFFIX = ".AllDay.NFT"
const ALLDAY_DEPOSIT_EVENT = "A.e4cf4bdc1751c65d.AllDay.Deposit"
const ALLDAY_WITHDRAW_EVENT = "A.e4cf4bdc1751c65d.AllDay.Withdraw"

const FLOW_REST = "https://rest-mainnet.onflow.org"
const CHUNK_SIZE = 250
const DEFAULT_SCAN_RANGE = 50_000
const MAX_SCAN_RANGE = 100_000
const INTER_CHUNK_DELAY_MS = 75
// Cap Cadence borrow attempts per run. Flow REST shares a 20 req/s budget
// across the project, and each unresolved sale costs 1-2 script calls
// (borrow + optional getEditionData).
const CADENCE_FALLBACK_MAX = 12
const CADENCE_DELAY_MS = 150
const SCRIPT_TIMEOUT_MS = 15_000
// Cap V1 tx-decode fallback calls per run (1 REST hit per sale not in
// cached_listings_v2 + buyer/seller/price extraction). Independent budget
// from the Cadence cap so the two don't starve each other.
const V1_TX_DECODE_MAX = 25
const V1_TX_DECODE_DELAY_MS = 100

// Addresses that appear in every Flowty purchase envelope but are never the
// buyer. Normalised to 0x + 16-hex-chars for set lookups.
const EXCLUDED_ADDRESSES = new Set<string>([
  "0x3cdbb3d569211ff3", // Flowty storefront escrow / seller
  "0x18eb4ee6b3c026d2", // Flowty fee payer
  "0xead892083b3e2c6c", // Dapper DUC co-signer
])

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

function normalizeAddress(raw: string): string {
  const hex = raw.trim().toLowerCase().replace(/^0x/, "")
  return `0x${hex.padStart(16, "0")}`
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
        return value
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

function extractNftTypeId(field: unknown): string | undefined {
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
    console.log(`[allday-sales-indexer] events ${start}-${end} ${type.split(".").pop()} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
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

// Tx-authorizer fallback used by V2 path only — V2 events don't always carry
// the buyer in the payload, so we walk the tx's proposer/authorizers/payer.
// V1 path uses decodeV1SaleTx which pulls the buyer from AllDay.Deposit.to
// directly.
async function fetchTxBuyers(txId: string): Promise<string[]> {
  try {
    const clean = txId.replace(/^0x/, "")
    const res = await fetch(`${FLOW_REST}/v1/transactions/${clean}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return []
    const json = (await res.json()) as {
      proposal_key?: { address?: string }
      authorizers?: string[]
      payer?: string
    }
    const candidates = new Set<string>()
    if (json.proposal_key?.address) candidates.add(normalizeAddress(json.proposal_key.address))
    for (const a of json.authorizers ?? []) candidates.add(normalizeAddress(a))
    if (json.payer) candidates.add(normalizeAddress(json.payer))
    return Array.from(candidates).filter((a) => !EXCLUDED_ADDRESSES.has(a))
  } catch {
    return []
  }
}

// AllDay-typed borrow: the public capability at /public/AllDayNFTCollection is
// published as a `&AllDay.Collection` (the contract's concrete collection
// resource). Borrowing the concrete type lets us call the AllDay-specific
// `borrowMomentNFT(id:)` accessor, which returns `&AllDay.NFT?` directly with
// editionID, serialNumber, and mintingDate fields exposed.
const BORROW_MOMENT_SCRIPT = `
import AllDay from 0xe4cf4bdc1751c65d
access(all) fun main(buyer: Address, id: UInt64): {String: String}? {
  let col = getAccount(buyer).capabilities.borrow<&AllDay.Collection>(/public/AllDayNFTCollection)
  if col == nil { return nil }
  let nft = col!.borrowMomentNFT(id: id)
  if nft == nil { return nil }
  return {
    "id": nft!.id.toString(),
    "editionID": nft!.editionID.toString(),
    "serialNumber": nft!.serialNumber.toString(),
    "mintingDate": nft!.mintingDate.toString()
  }
}
`

const GET_EDITION_DATA_SCRIPT = `
import AllDay from 0xe4cf4bdc1751c65d
access(all) fun main(editionID: UInt64): {String: String}? {
  let edOpt = AllDay.getEditionData(id: editionID)
  if edOpt == nil { return nil }
  let ed = edOpt!
  let result: {String: String} = {
    "playID": ed.playID.toString(),
    "setID": ed.setID.toString(),
    "tier": ed.tier ?? "COMMON",
    "maxMintSize": ed.maxMintSize?.toString() ?? "",
    "numMinted": ed.numMinted.toString()
  }
  let playOpt = AllDay.getPlayData(id: ed.playID)
  if playOpt != nil {
    let meta = playOpt!.metadata
    result["playerName"] = meta["playerFullName"] ?? meta["playerName"] ?? ""
    result["teamName"] = meta["teamName"] ?? ""
    result["playType"] = meta["playType"] ?? ""
    result["dateOfMoment"] = meta["dateOfMoment"] ?? ""
    result["awayTeamName"] = meta["awayTeamName"] ?? ""
    result["homeTeamName"] = meta["homeTeamName"] ?? ""
  }
  let setOpt = AllDay.getSetData(id: ed.setID)
  if setOpt != nil {
    result["setName"] = setOpt!.name
    result["seriesID"] = setOpt!.seriesID.toString()
    let seriesOpt = AllDay.getSeriesData(id: setOpt!.seriesID)
    if seriesOpt != nil {
      result["seriesName"] = seriesOpt!.name
    }
  }
  return result
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

function normalizeTier(raw: string | undefined | null): string | null {
  if (!raw) return null
  const t = String(raw).toUpperCase()
  if (t.includes("ULTIMATE")) return "ULTIMATE"
  if (t.includes("LEGENDARY")) return "LEGENDARY"
  if (t.includes("RARE")) return "RARE"
  if (t.includes("COMMON")) return "COMMON"
  return null
}

function buildOnChainEditionRow(
  editionID: string,
  data: Record<string, string>,
  now: string,
): Record<string, unknown> {
  const playerName = (data.playerName ?? "").trim() || null
  const setName = (data.setName ?? "").trim() || null
  const teamName = (data.teamName ?? "").trim() || null
  const numMinted = Number(data.numMinted)
  const maxMint = Number(data.maxMintSize)
  const circulation = Number.isFinite(maxMint) && maxMint > 0
    ? maxMint
    : Number.isFinite(numMinted) && numMinted > 0
    ? numMinted
    : null
  const seriesID = Number(data.seriesID)
  const setIdOnchain = Number(data.setID)
  const playIdOnchain = Number(data.playID)
  const dateRaw = data.dateOfMoment ? String(data.dateOfMoment).slice(0, 10) : null
  const gameDate = dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : null
  const composedName =
    playerName && setName ? `${playerName} — ${setName}` : playerName ?? setName

  return {
    external_id: editionID,
    collection_id: ALLDAY_COLLECTION_ID,
    collection: COLLECTION_SLUG,
    name: composedName,
    player_name: playerName,
    set_name: setName,
    team_name: teamName,
    tier: normalizeTier(data.tier),
    series: Number.isFinite(seriesID) && seriesID > 0 ? seriesID : null,
    circulation_count: circulation,
    set_id_onchain: Number.isFinite(setIdOnchain) ? setIdOnchain : null,
    play_id_onchain: Number.isFinite(playIdOnchain) ? playIdOnchain : null,
    play_type: (data.playType ?? "").trim() || null,
    game_date: gameDate,
    home_team: (data.homeTeamName ?? "").trim() || null,
    away_team: (data.awayTeamName ?? "").trim() || null,
    updated_at: now,
  }
}

type SaleSource = "v1_dapper" | "v2_flowty"

interface Sale {
  saleSource: SaleSource
  blockHeight: number
  blockTimestamp: string
  transactionId: string
  nftID: string
  listingResourceID: string
  // V2 carries these inline; V1 fills them via cached_listings_v2 lookup
  // or decodeV1SaleTx.
  salePrice: string | null
  seller: string | null
  buyer: string | null
}

export async function POST(req: NextRequest) {
  const start = Date.now()
  const startedAt = new Date().toISOString()

  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || (bearer !== TOKEN && urlToken !== TOKEN)) return unauthorized()

  const chain = req.nextUrl.searchParams.get("chain") === "true"
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

    const resolverStartedAt = new Date().toISOString()
    let resolverAttempted = 0
    let resolverResolved = 0
    let resolverSkipped = 0
    let resolverNewEditionsHydrated = 0
    let resolverNewEditionsOnchain = 0

    try {
      const { data: cursorRow, error: cursorErr } = await (supabaseAdmin as any)
        .from("event_cursor")
        .select("last_processed_block")
        .eq("id", "allday_sales")
        .single()

      if (cursorErr) {
        throw new Error(`cursor read error: ${cursorErr.message}`)
      }

      let lastBlock = Number(cursorRow?.last_processed_block ?? 0)
      const currentHeight = await getLatestSealedHeight()

      if (lastBlock === 0) {
        lastBlock = Math.max(currentHeight - maxRange, 0)
        console.log(`[allday-sales-indexer] first run, starting from block ${lastBlock}`)
      }

      cursorBefore = String(lastBlock)
      const targetHeight = Math.min(lastBlock + maxRange, currentHeight)
      cursorAfter = String(lastBlock)

      if (lastBlock >= currentHeight) {
        await fireSupabaseEdgeFunction("allday-unmapped-resolver", { batch_size: 5 })
        await fireNextPipelineStep("/api/fmv-recalc", chain)
        extra.message = "already up to date"
        return
      }

      console.log(`[allday-sales-indexer] scanning ${lastBlock + 1} → ${targetHeight} (${targetHeight - lastBlock} blocks)`)

      const sales: Sale[] = []
      let rawV1 = 0
      let rawV2 = 0
      let v1FilteredIn = 0
      let v2FilteredIn = 0
      let v1NonAllDay = 0
      let v1Cancellations = 0

      for (let s = lastBlock + 1; s <= targetHeight; s += CHUNK_SIZE) {
        const e = Math.min(s + CHUNK_SIZE - 1, targetHeight)
        try {
          const [v1Blocks, v2Blocks] = await Promise.all([
            fetchEventRange(V1_LISTING_COMPLETED, s, e),
            fetchEventRange(V2_LISTING_COMPLETED, s, e),
          ])

          // ── V1 (primary) ───────────────────────────────────────────────────
          for (const blk of v1Blocks) {
            const bh = Number(blk.block_height)
            const bts = blk.block_timestamp
            for (const evt of blk.events ?? []) {
              rawV1++
              try {
                const raw = JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))
                const payload = unwrapCdc(raw) as Record<string, any>
                const typeId = extractNftTypeId(payload?.nftType)
                if (!typeId || !typeId.endsWith(ALLDAY_NFT_TYPE_SUFFIX)) {
                  v1NonAllDay++
                  continue
                }
                if (payload.purchased !== true) {
                  v1Cancellations++
                  continue
                }
                sales.push({
                  saleSource: "v1_dapper",
                  blockHeight: bh,
                  blockTimestamp: bts,
                  transactionId: evt.transaction_id,
                  nftID: String(payload.nftID),
                  listingResourceID: String(payload.listingResourceID),
                  salePrice: null,
                  seller: null,
                  buyer: null,
                })
                v1FilteredIn++
              } catch (err) {
                console.log(
                  "[allday-sales-indexer] V1 decode err:",
                  err instanceof Error ? err.message : String(err)
                )
              }
            }
          }

          // ── V2 (legacy Flowty fork) ─────────────────────────────────────────
          for (const blk of v2Blocks) {
            const bh = Number(blk.block_height)
            const bts = blk.block_timestamp
            for (const evt of blk.events ?? []) {
              rawV2++
              try {
                const raw = JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))
                const payload = unwrapCdc(raw) as Record<string, any>
                const typeId = extractNftTypeId(payload?.nftType)
                if (!typeId || !typeId.endsWith(ALLDAY_NFT_TYPE_SUFFIX)) continue
                if (payload.purchased !== true) continue

                const sellerVal = payload.storefrontAddress
                const buyerVal = payload.buyer
                sales.push({
                  saleSource: "v2_flowty",
                  blockHeight: bh,
                  blockTimestamp: bts,
                  transactionId: evt.transaction_id,
                  nftID: String(payload.nftID),
                  listingResourceID: String(payload.listingResourceID ?? ""),
                  salePrice: String(payload.salePrice ?? "0"),
                  seller: typeof sellerVal === "string" ? sellerVal : null,
                  buyer: typeof buyerVal === "string" ? buyerVal : null,
                })
                v2FilteredIn++
              } catch (err) {
                console.log(
                  "[allday-sales-indexer] V2 decode err:",
                  err instanceof Error ? err.message : String(err)
                )
              }
            }
          }
        } catch (err) {
          console.log(
            `[allday-sales-indexer] chunk ${s}-${e} error:`,
            err instanceof Error ? err.message : String(err)
          )
        }
        if (s + CHUNK_SIZE <= targetHeight) await delay(INTER_CHUNK_DELAY_MS)
      }

      rowsFound = sales.length
      console.log(
        `[allday-sales-indexer] range=${lastBlock + 1}-${targetHeight} rawV1=${rawV1} rawV2=${rawV2} v1Sales=${v1FilteredIn} v2Sales=${v2FilteredIn}`
      )
      extra.raw_v1_events = rawV1
      extra.raw_v2_events = rawV2
      extra.v1_filtered_in = v1FilteredIn
      extra.v2_filtered_in = v2FilteredIn
      extra.v1_non_allday = v1NonAllDay
      extra.v1_cancellations = v1Cancellations

      // ── V1 price + buyer + seller enrichment ───────────────────────────────
      const v1Sales = sales.filter((s) => s.saleSource === "v1_dapper")
      const v1UncertainPriceSales: Array<{ sale: Sale; reason: string; samples: number[] }> = []

      if (v1Sales.length > 0) {
        // Step 1: bulk lookup cached_listings_v2 by listing_resource_id.
        const lrids = [...new Set(v1Sales.map((s) => s.listingResourceID))].filter((x) => x.length > 0)
        const cachedByLrid = new Map<string, { price_usd: number | null; seller_address: string | null }>()
        if (lrids.length > 0) {
          for (let i = 0; i < lrids.length; i += 500) {
            const batch = lrids.slice(i, i + 500)
            const { data } = await (supabaseAdmin as any)
              .from("cached_listings_v2")
              .select("listing_resource_id, price_usd, seller_address")
              .eq("collection_id", ALLDAY_COLLECTION_ID)
              .in("listing_resource_id", batch)
            for (const row of data ?? []) {
              // Multiple source rows could collide on listing_resource_id;
              // first-non-null-price wins (direct listings carry real prices,
              // flowty mirrors sometimes don't).
              const existing = cachedByLrid.get(row.listing_resource_id)
              if (!existing || (existing.price_usd == null && row.price_usd != null)) {
                cachedByLrid.set(row.listing_resource_id, {
                  price_usd: row.price_usd,
                  seller_address: row.seller_address,
                })
              }
            }
          }
        }

        let v1TxDecodeUsed = 0
        let v1CacheHits = 0
        let v1UncertainCount = 0

        for (const sale of v1Sales) {
          const cached = cachedByLrid.get(sale.listingResourceID)
          if (cached && cached.price_usd != null) {
            // Cache hit: take price + seller from cached listing, still need
            // to fetch tx for buyer (cached_listings_v2 has no buyer field).
            sale.salePrice = String(cached.price_usd)
            sale.seller = cached.seller_address ?? sale.seller
            v1CacheHits++
            if (v1TxDecodeUsed < V1_TX_DECODE_MAX) {
              v1TxDecodeUsed++
              const decoded = await decodeV1SaleTx(sale.transactionId, {
                depositEventType: ALLDAY_DEPOSIT_EVENT,
                withdrawEventType: ALLDAY_WITHDRAW_EVENT,
                nftId: sale.nftID,
              })
              sale.buyer = decoded.buyer ?? sale.buyer
              if (!sale.seller) sale.seller = decoded.seller ?? null
              await delay(V1_TX_DECODE_DELAY_MS)
            }
            continue
          }

          // Cache miss: full tx decode for buyer/seller/price.
          if (v1TxDecodeUsed >= V1_TX_DECODE_MAX) {
            v1UncertainPriceSales.push({
              sale,
              reason: "v1_tx_decode_budget_exhausted",
              samples: [],
            })
            v1UncertainCount++
            continue
          }
          v1TxDecodeUsed++
          const decoded = await decodeV1SaleTx(sale.transactionId, {
            depositEventType: ALLDAY_DEPOSIT_EVENT,
            withdrawEventType: ALLDAY_WITHDRAW_EVENT,
            nftId: sale.nftID,
          })
          await delay(V1_TX_DECODE_DELAY_MS)

          sale.buyer = decoded.buyer ?? null
          sale.seller = decoded.seller ?? null
          if (decoded.priceCertain && decoded.priceDuc != null) {
            sale.salePrice = String(decoded.priceDuc)
          } else {
            v1UncertainPriceSales.push({
              sale,
              reason: decoded.priceReason,
              samples: decoded.sampleAmounts,
            })
            v1UncertainCount++
          }
        }

        extra.v1_cache_hits = v1CacheHits
        extra.v1_tx_decode_used = v1TxDecodeUsed
        extra.v1_uncertain_count = v1UncertainCount
      }

      // Resolve nftID → edition_key (+ serial_number) via wallet_moments_cache
      const uniqueNftIds = [...new Set(sales.map((s) => s.nftID))]
      const nftToEditionKey = new Map<string, string>()
      const nftToSerial = new Map<string, number>()
      if (uniqueNftIds.length > 0) {
        for (let i = 0; i < uniqueNftIds.length; i += 500) {
          const batch = uniqueNftIds.slice(i, i + 500)
          const { data } = await (supabaseAdmin as any)
            .from("wallet_moments_cache")
            .select("moment_id, edition_key, serial_number")
            .eq("collection_id", ALLDAY_COLLECTION_ID)
            .in("moment_id", batch)
          for (const row of data ?? []) {
            if (row.edition_key) nftToEditionKey.set(row.moment_id, row.edition_key)
            const serial = Number(row.serial_number)
            if (Number.isFinite(serial) && serial > 0) nftToSerial.set(row.moment_id, serial)
          }
        }
      }

      // Cadence borrow fallback against buyer wallet for sales the cache
      // missed. V1 sales whose buyer was resolved via decodeV1SaleTx use that
      // buyer; V2 sales fall back to tx authorizers as before.
      const unresolvedSales = sales.filter((s) => !nftToEditionKey.has(s.nftID))
      const newlyResolved: Array<{ nft_id: string; edition_external_id: string; serial_number: number }> = []
      const seen = new Set<string>()
      const editionsToHydrate = new Set<string>()

      for (const sale of unresolvedSales) {
        if (resolverAttempted >= CADENCE_FALLBACK_MAX) break
        if (seen.has(sale.nftID) || nftToEditionKey.has(sale.nftID)) continue
        seen.add(sale.nftID)
        resolverAttempted++

        const candidates: string[] = []
        if (sale.buyer) candidates.push(normalizeAddress(sale.buyer))
        if (candidates.length === 0) {
          const txBuyers = await fetchTxBuyers(sale.transactionId)
          for (const b of txBuyers) candidates.push(b)
        }
        if (candidates.length === 0) {
          resolverSkipped++
          continue
        }

        let resolvedEditionID: string | null = null
        let resolvedSerial = 0
        for (const buyer of candidates) {
          try {
            const result = (await runScript(BORROW_MOMENT_SCRIPT, [
              { type: "Address", value: buyer },
              { type: "UInt64", value: sale.nftID },
            ])) as Record<string, string> | null
            if (result && typeof result === "object" && result.editionID) {
              resolvedEditionID = String(result.editionID)
              const serial = Number(result.serialNumber)
              resolvedSerial = Number.isFinite(serial) ? serial : 0
              break
            }
          } catch (err) {
            console.log(
              `[allday-sales-indexer] borrow err nft=${sale.nftID} buyer=${buyer}:`,
              err instanceof Error ? err.message : String(err)
            )
          }
          await delay(CADENCE_DELAY_MS)
        }

        if (!resolvedEditionID) {
          resolverSkipped++
          continue
        }

        nftToEditionKey.set(sale.nftID, resolvedEditionID)
        if (resolvedSerial > 0) nftToSerial.set(sale.nftID, resolvedSerial)
        newlyResolved.push({
          nft_id: sale.nftID,
          edition_external_id: resolvedEditionID,
          serial_number: resolvedSerial,
        })
        editionsToHydrate.add(resolvedEditionID)
        resolverResolved++
        await delay(CADENCE_DELAY_MS)
      }

      if (newlyResolved.length > 0) {
        const { error: mapErr } = await (supabaseAdmin as any)
          .from("nft_edition_map")
          .upsert(
            newlyResolved.map((r) => ({ collection_id: ALLDAY_COLLECTION_ID, ...r })),
            { onConflict: "collection_id,nft_id", ignoreDuplicates: true }
          )
        if (mapErr) {
          console.log(`[allday-sales-indexer] nft_edition_map upsert err: ${mapErr.message}`)
        }
      }

      // Resolve edition_key → edition UUID (existing rows)
      const editionKeys = [...new Set(nftToEditionKey.values())]
      const editionKeyToId = new Map<string, string>()
      if (editionKeys.length > 0) {
        for (let i = 0; i < editionKeys.length; i += 500) {
          const batch = editionKeys.slice(i, i + 500)
          const { data } = await (supabaseAdmin as any)
            .from("editions")
            .select("id, external_id")
            .eq("collection_id", ALLDAY_COLLECTION_ID)
            .in("external_id", batch)
          for (const row of data ?? []) editionKeyToId.set(row.external_id, row.id)
        }
      }

      // Hydrate newly resolved editions via AllDay relay → on-chain fallback.
      const missingExternalIds = [...editionsToHydrate].filter((k) => !editionKeyToId.has(k))
      if (missingExternalIds.length > 0) {
        const now = new Date().toISOString()
        const upsertRows: Record<string, unknown>[] = []
        const hydratedHits: HydratedHit[] = []
        try {
          const hydrated = await hydrateAllDayEditions(missingExternalIds)
          for (const r of hydrated) {
            if (r.ok) {
              upsertRows.push(toUpsertRow(r))
              hydratedHits.push({ external_id: r.external_id, ok: true })
              resolverNewEditionsHydrated++
            } else {
              hydratedHits.push({ external_id: r.external_id, ok: false })
            }
          }
        } catch (err) {
          console.log(
            `[allday-sales-indexer] hydrateAllDayEditions err:`,
            err instanceof Error ? err.message : String(err)
          )
        }

        const stillMissing = missingExternalIds.filter(
          (k) => !hydratedHits.some((h) => h.external_id === k && h.ok)
        )
        for (const editionID of stillMissing) {
          try {
            const data = (await runScript(GET_EDITION_DATA_SCRIPT, [
              { type: "UInt64", value: editionID },
            ])) as Record<string, string> | null
            if (data && typeof data === "object") {
              upsertRows.push(buildOnChainEditionRow(editionID, data, now))
              resolverNewEditionsOnchain++
            } else {
              console.log(`[allday-sales-indexer] getEditionData nil for ${editionID}`)
            }
          } catch (err) {
            console.log(
              `[allday-sales-indexer] getEditionData err edition=${editionID}:`,
              err instanceof Error ? err.message : String(err)
            )
          }
          await delay(CADENCE_DELAY_MS)
        }

        if (upsertRows.length > 0) {
          const { data: inserted, error: upErr } = await (supabaseAdmin as any)
            .from("editions")
            .upsert(upsertRows, { onConflict: "external_id,collection_id", ignoreDuplicates: false })
            .select("id, external_id")
          if (upErr) {
            console.log(`[allday-sales-indexer] editions upsert err: ${upErr.message}`)
          }
          for (const row of inserted ?? []) {
            if (row.external_id && row.id) editionKeyToId.set(row.external_id, row.id)
          }
        }
      }

      // ── Build sales + unmapped rows ─────────────────────────────────────────
      const salesRows: any[] = []
      const unmappedRows: any[] = []
      const unresolvedNftIds: string[] = []
      const ingestedAt = new Date().toISOString()

      // Build a fast lookup for V1 sales flagged as price-uncertain so we
      // don't write them to `sales` with a guessed price — they go straight
      // to unmapped_sales with a resolution_hint capturing the sample DUC
      // amounts so offline investigation can identify the pattern.
      const uncertainTxToReason = new Map<string, { reason: string; samples: number[] }>()
      for (const u of v1UncertainPriceSales) {
        uncertainTxToReason.set(u.sale.transactionId, { reason: u.reason, samples: u.samples })
      }

      for (const s of sales) {
        const editionKey = nftToEditionKey.get(s.nftID) ?? null
        const editionId = editionKey ? editionKeyToId.get(editionKey) : null
        const priceCertain = !uncertainTxToReason.has(s.transactionId)
        const price = priceCertain && s.salePrice !== null ? parseFloat(s.salePrice) || 0 : 0
        const marketplace = s.saleSource === "v1_dapper" ? "nflallday" : "flowty"
        const source = s.saleSource === "v1_dapper" ? "onchain_dapper_v1" : "onchain"

        if (editionId && priceCertain) {
          salesRows.push({
            id: crypto.randomUUID(),
            edition_id: editionId,
            collection_id: ALLDAY_COLLECTION_ID,
            collection: COLLECTION_SLUG,
            nft_id: s.nftID,
            price_usd: price,
            serial_number: nftToSerial.get(s.nftID) ?? 0,
            sold_at: s.blockTimestamp,
            marketplace,
            source,
            block_height: s.blockHeight,
            transaction_hash: s.transactionId,
            buyer_address: s.buyer,
            seller_address: s.seller,
            ingested_at: ingestedAt,
          })
        } else {
          unresolvedNftIds.push(s.nftID)
          const hint: Record<string, unknown> = { nft_id: s.nftID, sale_source: s.saleSource }
          if (editionKey) hint.edition_id = editionKey
          if (!priceCertain) {
            const u = uncertainTxToReason.get(s.transactionId)
            if (u) {
              hint.price_extraction = u.reason
              hint.sample_duc_amounts = u.samples
            }
          }
          unmappedRows.push({
            id: crypto.randomUUID(),
            collection_id: ALLDAY_COLLECTION_ID,
            nft_id: s.nftID,
            serial_number: 0,
            price_usd: priceCertain && s.salePrice !== null ? price : 0,
            marketplace,
            transaction_hash: s.transactionId,
            block_height: s.blockHeight,
            sold_at: s.blockTimestamp,
            ingested_at: ingestedAt,
            source,
            buyer_address: s.buyer,
            seller_address: s.seller,
            resolution_hint: hint,
          })
        }
      }

      for (let i = 0; i < salesRows.length; i += 100) {
        const batch = salesRows.slice(i, i + 100)
        const { error } = await (supabaseAdmin as any).from("sales").insert(batch)
        if (error) {
          if (error.code === "23505") {
            // dupes — not new writes
          } else {
            console.log("[allday-sales-indexer] sales batch insert err:", error.message)
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
            console.log("[allday-sales-indexer] unmapped batch insert err:", error.message)
            for (const row of batch) {
              const { error: se } = await (supabaseAdmin as any).from("unmapped_sales").insert(row)
              if (!se) rowsSkipped++
            }
          }
        } else {
          rowsSkipped += batch.length
        }
      }

      await (supabaseAdmin as any)
        .from("event_cursor")
        .update({ last_processed_block: targetHeight, updated_at: new Date().toISOString() })
        .eq("id", "allday_sales")
      cursorAfter = String(targetHeight)

      extra.blocks_scanned = targetHeight - lastBlock
      extra.cadence_resolved = resolverResolved
      extra.cadence_attempted = resolverAttempted
      extra.editions_hydrated_from_relay = resolverNewEditionsHydrated
      extra.editions_hydrated_from_chain = resolverNewEditionsOnchain
      extra.unresolved_sample = unresolvedNftIds.slice(0, 20)
      extra.v1_uncertain_sample = v1UncertainPriceSales
        .slice(0, 10)
        .map((u) => ({ tx: u.sale.transactionId, reason: u.reason, samples: u.samples }))
      extra.elapsed_ms = Date.now() - start

      await fireSupabaseEdgeFunction("allday-unmapped-resolver", { batch_size: 5 })
      await fireNextPipelineStep("/api/fmv-recalc", chain)
    } catch (err) {
      ok = false
      errorMsg = err instanceof Error ? err.message : String(err)
      console.log(`[allday-sales-indexer] fatal:`, errorMsg)
    } finally {
      try {
        await (supabaseAdmin as any).rpc("promote_unmapped_sales", {
          p_collection_id: ALLDAY_COLLECTION_ID,
        })
      } catch (e) {
        console.log(
          `[allday-sales-indexer] promote_unmapped_sales err:`,
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
          `[allday-sales-indexer] log_pipeline_run err:`,
          e instanceof Error ? e.message : String(e)
        )
      }

      try {
        const { error } = await (supabaseAdmin as any).from("pipeline_runs").insert({
          pipeline: RESOLVER_PIPELINE_NAME,
          collection_slug: COLLECTION_SLUG,
          started_at: resolverStartedAt,
          finished_at: new Date().toISOString(),
          rows_found: resolverAttempted,
          rows_written: resolverResolved,
          rows_skipped: resolverSkipped,
          ok,
          error: errorMsg,
          extra: {
            editions_hydrated_from_relay: resolverNewEditionsHydrated,
            editions_hydrated_from_chain: resolverNewEditionsOnchain,
            cadence_fallback_max: CADENCE_FALLBACK_MAX,
          },
        })
        if (error) {
          console.log(
            `[allday-edition-resolver] pipeline_runs insert error: code=${(error as any).code ?? "?"} msg=${(error.message ?? "?").slice(0, 200)}`
          )
        }
      } catch (e) {
        console.log(
          `[allday-edition-resolver] pipeline_runs insert threw: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    }
  })

  return NextResponse.json({ ok: true, message: "indexing started" })
}

interface HydratedHit {
  external_id: string
  ok: boolean
}

export async function GET(req: NextRequest) {
  return POST(req)
}
