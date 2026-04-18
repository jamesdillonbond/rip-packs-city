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
const CADENCE_FALLBACK_MAX = 30
const CADENCE_DELAY_MS = 150

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

// UFC editions are keyed by slug(editionName, max) — the same derivation used
// by seed-ufc-editions, scan-ufc-wallet, and ufc-listing-cache — so inline
// resolution has to return the upstream name/max/serial and slug client-side.
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

// Borrow via the standard NonFungibleToken.Collection interface + borrowNFT
// (mirrors the AllDay indexer). The narrower `{UFC_NFT.MomentNFTCollectionPublic}`
// + `borrowMomentNFT` form fails on wallets that publish only the generic
// capability, which left nft_edition_map empty and pushed every sale to
// unmapped_sales. UFC_NFT exposes edition metadata via MetadataViews.Editions,
// so the borrow still returns (name, max, serial) as strings and we slug
// client-side into the editions.external_id format.
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

    // Inline edition resolution: for sales that missed wallet_moments_cache,
    // look up the real buyer via the tx's proposer/authorizers/payer, borrow
    // the NFT from that wallet to read edition name/max/serial, and slug it
    // into the same external_id format used by the rest of the pipeline.
    const unresolvedSales = sales.filter((s) => !nftToEditionKey.has(s.nftID))
    const nftToSerial = new Map<string, number>()
    const newlyResolved: Array<{
      nft_id: string
      edition_external_id: string
      serial_number: number
    }> = []
    let cadenceResolved = 0
    const seenNft = new Set<string>()
    for (const sale of unresolvedSales) {
      if (cadenceResolved >= CADENCE_FALLBACK_MAX) break
      if (seenNft.has(sale.nftID) || nftToEditionKey.has(sale.nftID)) continue
      seenNft.add(sale.nftID)
      try {
        const buyers = await fetchTxBuyers(sale.transactionId)
        if (buyers.length === 0) continue
        const result = (await runScript(BORROW_EDITION_SCRIPT, [
          {
            type: "Array",
            value: buyers.map((a) => ({ type: "Address", value: a })),
          },
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
        console.log(
          `[ufc-sales-indexer] cadence fallback err nft=${sale.nftID}:`,
          err instanceof Error ? err.message : String(err)
        )
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
          serial_number: nftToSerial.get(s.nftID) ?? 0,
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
    extra.cadence_resolved = cadenceResolved
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
