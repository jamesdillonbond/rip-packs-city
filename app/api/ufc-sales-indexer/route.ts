import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { decodeV1SaleTx } from "@/lib/dapper-v1-tx-decode"
import crypto from "crypto"

// ── On-chain UFC Strike sales indexer ────────────────────────────────────────
//
// Dual-path: scans V1 Dapper NFTStorefront (A.4eb8a10cb9f87357.NFTStorefront)
// for native UFC Strike sales alongside the V2 Flowty fork. See
// allday-sales-indexer header for the full architecture rationale. UFC Strike
// editions are keyed by slug(editionName, max) — the same derivation used by
// seed-ufc-editions, scan-ufc-wallet, and ufc-listing-cache — so inline
// edition resolution slugs name/max/serial client-side after the Cadence
// borrow.
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const UFC_COLLECTION_ID = "9b4824a8-736d-4a96-b450-8dcc0c46b023"
const COLLECTION_SLUG = "ufc_strike"
const PIPELINE_NAME = "ufc-sales-indexer"

const V1_LISTING_COMPLETED = "A.4eb8a10cb9f87357.NFTStorefront.ListingCompleted"
const V2_LISTING_COMPLETED = "A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted"

const UFC_NFT_TYPE_SUFFIX = ".UFC_NFT.NFT"
const UFC_DEPOSIT_EVENT = "A.329feb3ab062d289.UFC_NFT.Deposit"
const UFC_WITHDRAW_EVENT = "A.329feb3ab062d289.UFC_NFT.Withdraw"

const FLOW_REST = "https://rest-mainnet.onflow.org"
const CHUNK_SIZE = 250
const DEFAULT_SCAN_RANGE = 50_000
const MAX_SCAN_RANGE = 100_000
const INTER_CHUNK_DELAY_MS = 75
const CADENCE_FALLBACK_MAX = 30
const CADENCE_DELAY_MS = 150
const V1_TX_DECODE_MAX = 25
const V1_TX_DECODE_DELAY_MS = 100

const EXCLUDED_ADDRESSES = new Set<string>([
  "0x3cdbb3d569211ff3",
  "0x18eb4ee6b3c026d2",
  "0xead892083b3e2c6c",
])

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

function normalizeAddress(raw: string): string {
  const hex = raw.trim().toLowerCase().replace(/^0x/, "")
  return `0x${hex.padStart(16, "0")}`
}

function slugifyUfcEdition(name: string, max: number | null): string {
  const clean = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return max !== null ? `${clean}-${max}` : clean
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
    console.log(`[ufc-sales-indexer] events ${start}-${end} ${type.split(".").pop()} HTTP ${res.status}`)
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

const BORROW_EDITION_SCRIPT = `
import NonFungibleToken from 0x1d7e57aa55817448
import MetadataViews from 0x1d7e57aa55817448
access(all) fun main(owners: [Address], id: UInt64): [String] {
  for owner in owners {
    let col = getAccount(owner).capabilities
      .borrow<&{NonFungibleToken.Collection}>(/public/UFC_NFTCollection)
    if col == nil { continue }
    let nft = col!.borrowNFT(id)
    if nft == nil { continue }
    if let editions = nft!.resolveView(Type<MetadataViews.Editions>()) {
      let e = editions as! MetadataViews.Editions
      if e.infoList.length > 0 {
        let info = e.infoList[0]
        let name = info.name ?? ""
        let serial = info.number.toString()
        let maxStr = info.max != nil ? info.max!.toString() : ""
        return [name, maxStr, serial]
      }
    }
  }
  return []
}
`

async function runScript(code: string, args: Array<{ type: string; value: unknown }>): Promise<unknown> {
  const body = {
    script: Buffer.from(code).toString("base64"),
    arguments: args.map((a) => Buffer.from(JSON.stringify(a)).toString("base64")),
  }
  const res = await fetch(`${FLOW_REST}/v1/scripts?block_height=sealed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`script HTTP ${res.status}`)
  const json = (await res.json()) as string | { value: string }
  const b64 = typeof json === "string" ? json : json.value
  const decoded = JSON.parse(Buffer.from(b64, "base64").toString("utf8"))
  return unwrapCdc(decoded)
}

type SaleSource = "v1_dapper" | "v2_flowty"

interface Sale {
  saleSource: SaleSource
  blockHeight: number
  blockTimestamp: string
  transactionId: string
  nftID: string
  listingResourceID: string
  salePrice: string | null
  seller: string | null
  buyer: string | null
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

    if (cursorErr) throw new Error(`cursor read error: ${cursorErr.message}`)

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

    const sales: Sale[] = []
    let lastChunkEnd = lastBlock
    let rawV1 = 0
    let rawV2 = 0
    let v1FilteredIn = 0
    let v2FilteredIn = 0
    let v1NonUfc = 0
    let v1Cancellations = 0

    for (let s = lastBlock + 1; s <= targetHeight; s += CHUNK_SIZE) {
      const e = Math.min(s + CHUNK_SIZE - 1, targetHeight)
      try {
        const [v1Blocks, v2Blocks] = await Promise.all([
          fetchEventRange(V1_LISTING_COMPLETED, s, e),
          fetchEventRange(V2_LISTING_COMPLETED, s, e),
        ])

        for (const blk of v1Blocks) {
          const bh = Number(blk.block_height)
          const bts = blk.block_timestamp
          for (const evt of blk.events ?? []) {
            rawV1++
            try {
              const raw = JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))
              const payload = unwrapCdc(raw) as Record<string, any>
              const typeId = extractNftTypeId(payload?.nftType)
              if (!typeId || !typeId.endsWith(UFC_NFT_TYPE_SUFFIX)) {
                v1NonUfc++
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
              console.log("[ufc-sales-indexer] V1 decode err:", err instanceof Error ? err.message : String(err))
            }
          }
        }

        for (const blk of v2Blocks) {
          const bh = Number(blk.block_height)
          const bts = blk.block_timestamp
          for (const evt of blk.events ?? []) {
            rawV2++
            try {
              const raw = JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))
              const payload = unwrapCdc(raw) as Record<string, any>
              const typeId = extractNftTypeId(payload?.nftType)
              if (!typeId || !typeId.endsWith(UFC_NFT_TYPE_SUFFIX)) continue
              if (payload.purchased !== true) continue

              sales.push({
                saleSource: "v2_flowty",
                blockHeight: bh,
                blockTimestamp: bts,
                transactionId: evt.transaction_id,
                nftID: String(payload.nftID),
                listingResourceID: String(payload.listingResourceID ?? ""),
                salePrice: String(payload.salePrice ?? "0"),
                seller: null,
                buyer: typeof payload.commissionReceiver === "string" ? payload.commissionReceiver : null,
              })
              v2FilteredIn++
            } catch (err) {
              console.log("[ufc-sales-indexer] V2 decode err:", err instanceof Error ? err.message : String(err))
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
    console.log(`[ufc-sales-indexer] range=${lastBlock + 1}-${targetHeight} rawV1=${rawV1} rawV2=${rawV2} v1Sales=${v1FilteredIn} v2Sales=${v2FilteredIn}`)
    extra.raw_v1_events = rawV1
    extra.raw_v2_events = rawV2
    extra.v1_filtered_in = v1FilteredIn
    extra.v2_filtered_in = v2FilteredIn
    extra.v1_non_ufc = v1NonUfc
    extra.v1_cancellations = v1Cancellations

    // ── V1 enrichment: cached_listings_v2 → tx-decode → unmapped ─────────────
    const v1Sales = sales.filter((s) => s.saleSource === "v1_dapper")
    const v1UncertainPriceSales: Array<{ sale: Sale; reason: string; samples: number[] }> = []

    if (v1Sales.length > 0) {
      const lrids = [...new Set(v1Sales.map((s) => s.listingResourceID))].filter((x) => x.length > 0)
      const cachedByLrid = new Map<string, { price_usd: number | null; seller_address: string | null }>()
      if (lrids.length > 0) {
        for (let i = 0; i < lrids.length; i += 500) {
          const batch = lrids.slice(i, i + 500)
          const { data } = await (supabaseAdmin as any)
            .from("cached_listings_v2")
            .select("listing_resource_id, price_usd, seller_address")
            .eq("collection_id", UFC_COLLECTION_ID)
            .in("listing_resource_id", batch)
          for (const row of data ?? []) {
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
          sale.salePrice = String(cached.price_usd)
          sale.seller = cached.seller_address ?? sale.seller
          v1CacheHits++
          if (v1TxDecodeUsed < V1_TX_DECODE_MAX) {
            v1TxDecodeUsed++
            const decoded = await decodeV1SaleTx(sale.transactionId, {
              depositEventType: UFC_DEPOSIT_EVENT,
              withdrawEventType: UFC_WITHDRAW_EVENT,
              nftId: sale.nftID,
            })
            sale.buyer = decoded.buyer ?? sale.buyer
            if (!sale.seller) sale.seller = decoded.seller ?? null
            await delay(V1_TX_DECODE_DELAY_MS)
          }
          continue
        }

        if (v1TxDecodeUsed >= V1_TX_DECODE_MAX) {
          v1UncertainPriceSales.push({ sale, reason: "v1_tx_decode_budget_exhausted", samples: [] })
          v1UncertainCount++
          continue
        }
        v1TxDecodeUsed++
        const decoded = await decodeV1SaleTx(sale.transactionId, {
          depositEventType: UFC_DEPOSIT_EVENT,
          withdrawEventType: UFC_WITHDRAW_EVENT,
          nftId: sale.nftID,
        })
        await delay(V1_TX_DECODE_DELAY_MS)

        sale.buyer = decoded.buyer ?? null
        sale.seller = decoded.seller ?? null
        if (decoded.priceCertain && decoded.priceDuc != null) {
          sale.salePrice = String(decoded.priceDuc)
        } else {
          v1UncertainPriceSales.push({ sale, reason: decoded.priceReason, samples: decoded.sampleAmounts })
          v1UncertainCount++
        }
      }

      extra.v1_cache_hits = v1CacheHits
      extra.v1_tx_decode_used = v1TxDecodeUsed
      extra.v1_uncertain_count = v1UncertainCount
    }

    // ── Edition resolution via wmc → Cadence borrow ──────────────────────────
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

    const unresolvedSales = sales.filter((s) => !nftToEditionKey.has(s.nftID))
    const nftToSerial = new Map<string, number>()
    const newlyResolved: Array<{ nft_id: string; edition_external_id: string; serial_number: number }> = []
    let cadenceResolved = 0
    const seenNft = new Set<string>()
    for (const sale of unresolvedSales) {
      if (cadenceResolved >= CADENCE_FALLBACK_MAX) break
      if (seenNft.has(sale.nftID) || nftToEditionKey.has(sale.nftID)) continue
      seenNft.add(sale.nftID)
      try {
        const candidates: string[] = []
        if (sale.buyer) candidates.push(normalizeAddress(sale.buyer))
        if (candidates.length === 0) {
          const txBuyers = await fetchTxBuyers(sale.transactionId)
          for (const b of txBuyers) candidates.push(b)
        }
        if (candidates.length === 0) continue

        const result = (await runScript(BORROW_EDITION_SCRIPT, [
          { type: "Array", value: candidates.map((a) => ({ type: "Address", value: a })) },
          { type: "UInt64", value: sale.nftID },
        ])) as unknown[] | null
        if (Array.isArray(result) && result.length >= 3) {
          const name = String(result[0] ?? "")
          const maxStr = String(result[1] ?? "")
          const serial = Number(result[2])
          if (!name) continue
          const max = maxStr === "" ? null : Number(maxStr)
          const editionKey = slugifyUfcEdition(name, Number.isFinite(max as number) ? (max as number) : null)
          nftToEditionKey.set(sale.nftID, editionKey)
          if (Number.isFinite(serial)) nftToSerial.set(sale.nftID, serial)
          newlyResolved.push({
            nft_id: sale.nftID,
            edition_external_id: editionKey,
            serial_number: Number.isFinite(serial) ? serial : 0,
          })
          cadenceResolved++
        }
      } catch (err) {
        console.log(`[ufc-sales-indexer] cadence fallback err nft=${sale.nftID}:`, err instanceof Error ? err.message : String(err))
      }
      await delay(CADENCE_DELAY_MS)
    }

    if (newlyResolved.length > 0) {
      const { error: mapErr } = await (supabaseAdmin as any)
        .from("nft_edition_map")
        .upsert(
          newlyResolved.map((r) => ({ collection_id: UFC_COLLECTION_ID, ...r })),
          { onConflict: "collection_id,nft_id", ignoreDuplicates: true }
        )
      if (mapErr) {
        console.log(`[ufc-sales-indexer] nft_edition_map upsert err: ${mapErr.message}`)
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

    const uncertainTxToReason = new Map<string, { reason: string; samples: number[] }>()
    for (const u of v1UncertainPriceSales) {
      uncertainTxToReason.set(u.sale.transactionId, { reason: u.reason, samples: u.samples })
    }

    const salesRows: any[] = []
    const unmappedRows: any[] = []
    const unresolvedNftIds: string[] = []
    const ingestedAt = new Date().toISOString()
    for (const s of sales) {
      const editionKey = nftToEditionKey.get(s.nftID) ?? null
      const editionId = editionKey ? editionKeyToId.get(editionKey) : null
      const priceCertain = !uncertainTxToReason.has(s.transactionId)
      const price = priceCertain && s.salePrice !== null ? parseFloat(s.salePrice) || 0 : 0
      const marketplace = s.saleSource === "v1_dapper" ? "ufcstrike" : "flowty"
      const source = s.saleSource === "v1_dapper" ? "onchain_dapper_v1" : "onchain"

      if (editionId && priceCertain) {
        salesRows.push({
          id: crypto.randomUUID(),
          edition_id: editionId,
          collection_id: UFC_COLLECTION_ID,
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
          collection_id: UFC_COLLECTION_ID,
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
    extra.cadence_resolved = cadenceResolved
    extra.unresolved_sample = unresolvedNftIds.slice(0, 20)
    extra.v1_uncertain_sample = v1UncertainPriceSales
      .slice(0, 10)
      .map((u) => ({ tx: u.sale.transactionId, reason: u.reason, samples: u.samples }))
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
      console.log("[ufc-sales-indexer] promote_unmapped_sales err:", e instanceof Error ? e.message : String(e))
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
      console.log("[ufc-sales-indexer] log_pipeline_run err:", e instanceof Error ? e.message : String(e))
    }
  }

  return response ?? NextResponse.json({ ok: false, error: "no response" }, { status: 500 })
}

export async function GET(req: NextRequest) { return runIndexer(req) }
export async function POST(req: NextRequest) { return runIndexer(req) }
