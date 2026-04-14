import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { fireNextPipelineStep } from "@/lib/pipeline-chain"
import crypto from "crypto"

// ── On-chain NFL All Day sales indexer ───────────────────────────────────────
//
// Scans Flow NFTStorefrontV2.ListingCompleted events via the Flow REST API,
// filters to AllDay NFT purchases, maps nftID → edition via wallet_moments_cache
// (with a Cadence borrow fallback through the script endpoint), and writes
// dedup'd rows into the partitioned `sales` table.
//
// This replaces the Flowty-based allday-ingest sales path, which returns empty
// nfts arrays for every page as of April 2026.
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const STOREFRONT_EVENT = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted"
const FLOW_REST = "https://rest-mainnet.onflow.org"
const CHUNK_SIZE = 250
const DEFAULT_SCAN_RANGE = 50_000
const MAX_SCAN_RANGE = 100_000
const INTER_CHUNK_DELAY_MS = 75
const CADENCE_FALLBACK_MAX = 30
const CADENCE_DELAY_MS = 150

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Cadence JSON unwrapper ────────────────────────────────────────────────────
// Mirrors the subset of cadence-json needed for ListingCompleted + Type values.

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

// ── Flow REST helpers ────────────────────────────────────────────────────────

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
    console.log(`[allday-sales-indexer] events ${start}-${end} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
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

async function getTxPayer(txId: string): Promise<string | null> {
  try {
    const res = await fetch(`${FLOW_REST}/v1/transactions/${txId}`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const json = (await res.json()) as { payer?: string }
    if (!json.payer) return null
    return json.payer.startsWith("0x") ? json.payer : `0x${json.payer}`
  } catch {
    return null
  }
}

const BORROW_EDITION_SCRIPT = `
import AllDay from 0xe4cf4bdc1751c65d
import NonFungibleToken from 0x1d7e57aa55817448
access(all) fun main(addr: Address, id: UInt64): UInt64? {
  let ref = getAccount(addr).capabilities.borrow<&{NonFungibleToken.Collection}>(/public/AllDayNFTCollection)
  if ref == nil { return nil }
  let nft = ref!.borrowNFT(id)
  if nft == nil { return nil }
  let ad = nft! as! &AllDay.NFT
  return ad.editionID
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
  const json = (await res.json()) as { value: string }
  const decoded = JSON.parse(Buffer.from(json.value, "base64").toString("utf8"))
  return unwrapCdc(decoded)
}

// ── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const start = Date.now()

  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || (bearer !== TOKEN && urlToken !== TOKEN)) return unauthorized()

  const chain = req.nextUrl.searchParams.get("chain") === "true"
  const rangeParam = Number(req.nextUrl.searchParams.get("range") ?? DEFAULT_SCAN_RANGE)
  const maxRange = Math.min(Math.max(rangeParam || DEFAULT_SCAN_RANGE, CHUNK_SIZE), MAX_SCAN_RANGE)

  after(async () => {
   try {
    const { data: cursorRow, error: cursorErr } = await (supabaseAdmin as any)
      .from("event_cursor")
      .select("last_processed_block")
      .eq("id", "allday_sales")
      .single()

    if (cursorErr) {
      console.log("[allday-sales-indexer] cursor read error:", cursorErr.message)
      return NextResponse.json({ error: "Failed to read cursor" }, { status: 500 })
    }

    let lastBlock = Number(cursorRow?.last_processed_block ?? 0)
    const currentHeight = await getLatestSealedHeight()

    if (lastBlock === 0) {
      lastBlock = Math.max(currentHeight - maxRange, 0)
      console.log(`[allday-sales-indexer] first run, starting from block ${lastBlock}`)
    }

    const targetHeight = Math.min(lastBlock + maxRange, currentHeight)

    if (lastBlock >= currentHeight) {
      await fireNextPipelineStep("/api/fmv-recalc", chain)
      return NextResponse.json({
        ok: true,
        message: "already up to date",
        cursor: lastBlock,
        elapsed: Date.now() - start,
      })
    }

    console.log(`[allday-sales-indexer] scanning ${lastBlock + 1} → ${targetHeight} (${targetHeight - lastBlock} blocks)`)

    interface Sale {
      blockHeight: number
      blockTimestamp: string
      transactionId: string
      nftID: string
      salePrice: string
      storefrontResourceID?: string
      commissionReceiver?: string | null
    }

    const sales: Sale[] = []

    for (let s = lastBlock + 1; s <= targetHeight; s += CHUNK_SIZE) {
      const e = Math.min(s + CHUNK_SIZE - 1, targetHeight)
      try {
        const blocks = await fetchEventRange(STOREFRONT_EVENT, s, e)
        for (const blk of blocks) {
          const bh = Number(blk.block_height)
          const bts = blk.block_timestamp
          for (const evt of blk.events ?? []) {
            try {
              const raw = JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))
              const payload = unwrapCdc(raw) as Record<string, any>
              const typeID: string | undefined = payload?.nftType?.staticType?.typeID
              if (!typeID || !typeID.includes("AllDay")) continue
              if (payload.purchased !== true) continue

              sales.push({
                blockHeight: bh,
                blockTimestamp: bts,
                transactionId: evt.transaction_id,
                nftID: String(payload.nftID),
                salePrice: String(payload.salePrice ?? "0"),
                storefrontResourceID: payload.storefrontResourceID
                  ? String(payload.storefrontResourceID)
                  : undefined,
                commissionReceiver: payload.commissionReceiver ?? null,
              })
            } catch (err) {
              console.log(
                "[allday-sales-indexer] decode err:",
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

    console.log(`[allday-sales-indexer] found ${sales.length} AllDay sales`)

    if (sales.length === 0) {
      await (supabaseAdmin as any)
        .from("event_cursor")
        .update({ last_processed_block: targetHeight, updated_at: new Date().toISOString() })
        .eq("id", "allday_sales")
      await fireNextPipelineStep("/api/fmv-recalc", chain)
      return NextResponse.json({
        ok: true,
        blocksScanned: targetHeight - lastBlock,
        eventsFound: 0,
        salesInserted: 0,
        cursor: targetHeight,
        elapsed: Date.now() - start,
      })
    }

    // Resolve nftID → edition_key via wallet_moments_cache
    const uniqueNftIds = [...new Set(sales.map((s) => s.nftID))]
    const nftToEditionKey = new Map<string, string>()
    for (let i = 0; i < uniqueNftIds.length; i += 500) {
      const batch = uniqueNftIds.slice(i, i + 500)
      const { data } = await (supabaseAdmin as any)
        .from("wallet_moments_cache")
        .select("moment_id, edition_key")
        .eq("collection_id", ALLDAY_COLLECTION_ID)
        .in("moment_id", batch)
      for (const row of data ?? []) {
        if (row.edition_key) nftToEditionKey.set(row.moment_id, row.edition_key)
      }
    }

    // Cadence borrow fallback for unresolved nftIDs — uses tx payer as the
    // current owner (buyer just received the NFT).
    const unresolvedSales = sales.filter((s) => !nftToEditionKey.has(s.nftID))
    let cadenceResolved = 0
    const seen = new Set<string>()
    for (const sale of unresolvedSales) {
      if (cadenceResolved >= CADENCE_FALLBACK_MAX) break
      if (seen.has(sale.nftID) || nftToEditionKey.has(sale.nftID)) continue
      seen.add(sale.nftID)
      try {
        const payer = await getTxPayer(sale.transactionId)
        if (!payer) continue
        const editionID = await runScript(BORROW_EDITION_SCRIPT, [
          { type: "Address", value: payer },
          { type: "UInt64", value: sale.nftID },
        ])
        if (editionID !== null && editionID !== undefined) {
          nftToEditionKey.set(sale.nftID, String(editionID))
          cadenceResolved++
        }
      } catch (err) {
        console.log(
          `[allday-sales-indexer] cadence fallback err nft=${sale.nftID}:`,
          err instanceof Error ? err.message : String(err)
        )
      }
      await delay(CADENCE_DELAY_MS)
    }

    // Resolve edition_key → edition UUID
    const editionKeys = [...new Set(nftToEditionKey.values())]
    const editionKeyToId = new Map<string, string>()
    for (let i = 0; i < editionKeys.length; i += 500) {
      const batch = editionKeys.slice(i, i + 500)
      const { data } = await (supabaseAdmin as any)
        .from("editions")
        .select("id, external_id")
        .eq("collection_id", ALLDAY_COLLECTION_ID)
        .in("external_id", batch)
      for (const row of data ?? []) editionKeyToId.set(row.external_id, row.id)
    }

    const rows: any[] = []
    const unresolvedIds: string[] = []
    for (const s of sales) {
      const editionKey = nftToEditionKey.get(s.nftID)
      const editionId = editionKey ? editionKeyToId.get(editionKey) : null
      if (!editionId) {
        unresolvedIds.push(s.nftID)
        continue
      }
      rows.push({
        id: crypto.randomUUID(),
        edition_id: editionId,
        collection_id: ALLDAY_COLLECTION_ID,
        collection: "nfl_all_day",
        nft_id: s.nftID,
        price_usd: parseFloat(s.salePrice) || 0,
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
    }

    let inserted = 0
    let duped = 0
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100)
      const { error } = await (supabaseAdmin as any).from("sales").insert(batch)
      if (error) {
        if (error.code === "23505") {
          duped += batch.length
        } else {
          console.log("[allday-sales-indexer] batch insert err:", error.message)
          for (const row of batch) {
            const { error: se } = await (supabaseAdmin as any).from("sales").insert(row)
            if (se) duped++
            else inserted++
          }
        }
      } else {
        inserted += batch.length
      }
    }

    await (supabaseAdmin as any)
      .from("event_cursor")
      .update({ last_processed_block: targetHeight, updated_at: new Date().toISOString() })
      .eq("id", "allday_sales")

    await fireNextPipelineStep("/api/fmv-recalc", chain)

    return NextResponse.json({
      ok: true,
      blocksScanned: targetHeight - lastBlock,
      eventsFound: sales.length,
      cadenceResolved,
      salesResolved: rows.length,
      salesInserted: inserted,
      salesDuped: duped,
      unresolved: unresolvedIds.slice(0, 50),
      unresolvedCount: unresolvedIds.length,
      cursor: targetHeight,
      elapsed: Date.now() - start,
    })
   } catch (err) {
    console.log("[allday-sales-indexer] fatal:", err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: "Internal server error", details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
   }
  })

  return NextResponse.json({ ok: true, message: "indexing started" })
}

export async function GET(req: NextRequest) {
  return POST(req)
}
