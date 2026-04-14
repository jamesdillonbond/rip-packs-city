import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { flowtyTraitsToPinnacleEdition } from "@/lib/pinnacle/pinnacleTypes"

const FLOWTY_PINNACLE_URL =
  "https://api2.flowty.io/collection/0xedf9df96c92f4595/Pinnacle"
const FLOWTY_LOOKUP_BUDGET = 5
const FLOWTY_LOOKUP_TIMEOUT_MS = 8000

// ── On-chain Disney Pinnacle sales indexer ───────────────────────────────────
// Scans NFTStorefrontV2.ListingCompleted, filters to Pinnacle NFT purchases,
// resolves nftID → edition_key via pinnacle_editions, and writes dedup'd sales
// into the pinnacle_sales table. Does NOT auto-run FMV recalc.

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const STOREFRONT_EVENT = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted"
const PINNACLE_TYPE_MATCH = "Pinnacle"
const FLOW_REST = "https://rest-mainnet.onflow.org"
const CHUNK_SIZE = 250
const MAX_SCAN_RANGE = 2_000
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
    console.log(`[pinnacle-sales-indexer] events ${start}-${end} HTTP ${res.status}`)
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

async function runIndexer(req: NextRequest) {
  const started = Date.now()

  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || (bearer !== TOKEN && urlToken !== TOKEN)) return unauthorized()

  const rangeParam = Number(req.nextUrl.searchParams.get("range") ?? MAX_SCAN_RANGE)
  const maxRange = Math.min(Math.max(rangeParam || MAX_SCAN_RANGE, CHUNK_SIZE), MAX_SCAN_RANGE)

  try {
    const { data: cursorRow, error: cursorErr } = await (supabaseAdmin as any)
      .from("event_cursor")
      .select("last_processed_block")
      .eq("id", "pinnacle_sales")
      .single()
    if (cursorErr) {
      console.log("[pinnacle-sales-indexer] cursor read error:", cursorErr.message)
      return NextResponse.json({ error: "Failed to read cursor" }, { status: 500 })
    }

    let lastBlock = Number(cursorRow?.last_processed_block ?? 0)
    const currentHeight = await getLatestSealedHeight()
    if (lastBlock >= currentHeight) {
      return NextResponse.json({ ok: true, message: "already up to date", cursor: lastBlock, elapsed: Date.now() - started })
    }

    const targetHeight = Math.min(lastBlock + maxRange, currentHeight)
    console.log(`[pinnacle-sales-indexer] scanning ${lastBlock + 1} → ${targetHeight} (${targetHeight - lastBlock} blocks)`)

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
              if (!typeID || !typeID.includes(PINNACLE_TYPE_MATCH)) continue
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
              console.log("[pinnacle-sales-indexer] decode err:", err instanceof Error ? err.message : String(err))
            }
          }
        }
        lastChunkEnd = e
        // Update cursor per chunk so partial progress isn't lost
        await (supabaseAdmin as any)
          .from("event_cursor")
          .update({ last_processed_block: lastChunkEnd, updated_at: new Date().toISOString() })
          .eq("id", "pinnacle_sales")
      } catch (err) {
        console.log(`[pinnacle-sales-indexer] chunk ${s}-${e} error:`, err instanceof Error ? err.message : String(err))
      }
      if (s + CHUNK_SIZE <= targetHeight) await delay(INTER_CHUNK_DELAY_MS)
    }

    console.log(`[pinnacle-sales-indexer] found ${sales.length} Pinnacle sales`)

    if (sales.length === 0) {
      return NextResponse.json({
        ok: true, blocksScanned: targetHeight - lastBlock, eventsFound: 0,
        salesInserted: 0, cursor: lastChunkEnd, elapsed: Date.now() - started,
      })
    }

    // Resolve nftID → edition_key. Primary source: pinnacle_nft_map (populated
    // by the regular pinnacle-ingest path). Secondary: wallet_moments_cache.
    // Final fallback: live Flowty lookup of individual NFTs (rate-limited to
    // FLOWTY_LOOKUP_BUDGET per invocation) — on hit, also backfill
    // pinnacle_nft_map so future runs don't need the lookup.
    const uniqueNftIds = [...new Set(sales.map((s) => s.nftID))]
    const nftToEditionId = new Map<string, string>()

    for (let i = 0; i < uniqueNftIds.length; i += 500) {
      const batch = uniqueNftIds.slice(i, i + 500)
      const { data } = await (supabaseAdmin as any)
        .from("pinnacle_nft_map")
        .select("nft_id, edition_key")
        .in("nft_id", batch)
      for (const row of data ?? []) {
        if (row.edition_key) nftToEditionId.set(String(row.nft_id), row.edition_key)
      }
    }

    const stillUnresolved = uniqueNftIds.filter((id) => !nftToEditionId.has(id))
    if (stillUnresolved.length > 0) {
      for (let i = 0; i < stillUnresolved.length; i += 500) {
        const batch = stillUnresolved.slice(i, i + 500)
        const { data } = await (supabaseAdmin as any)
          .from("wallet_moments_cache")
          .select("moment_id, edition_key")
          .eq("collection_id", "7dd9dd11-e8b6-45c4-ac99-71331f959714")
          .in("moment_id", batch)
        for (const row of data ?? []) {
          if (row.edition_key) nftToEditionId.set(row.moment_id, row.edition_key)
        }
      }
    }

    // Flowty last-resort lookup — bounded to avoid hammering the API.
    const flowtyTargets = uniqueNftIds.filter((id) => !nftToEditionId.has(id)).slice(0, FLOWTY_LOOKUP_BUDGET)
    let flowtyResolved = 0
    let flowtyAttempted = 0
    for (const nftId of flowtyTargets) {
      flowtyAttempted++
      try {
        const res = await fetch(FLOWTY_PINNACLE_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://www.flowty.io",
          },
          body: JSON.stringify({ filters: { id: [nftId] }, offset: 0, limit: 1 }),
          signal: AbortSignal.timeout(FLOWTY_LOOKUP_TIMEOUT_MS),
        })
        if (!res.ok) {
          console.log(`[pinnacle-sales-indexer] flowty lookup nft=${nftId} HTTP ${res.status}`)
          continue
        }
        const body = await res.json() as { nfts?: Array<{ id?: string; owner?: string; nftView?: { traits?: { traits?: Array<{ name: string; value: string }> } } }> }
        const hit = body.nfts?.[0]
        const traits = hit?.nftView?.traits?.traits ?? []
        if (!hit || traits.length === 0) continue
        const ed = flowtyTraitsToPinnacleEdition(traits)
        if (!ed.editionKey) continue
        nftToEditionId.set(nftId, ed.editionKey)
        flowtyResolved++
        await (supabaseAdmin as any)
          .from("pinnacle_nft_map")
          .upsert(
            { nft_id: nftId, edition_key: ed.editionKey, owner: hit.owner ?? null },
            { onConflict: "nft_id", ignoreDuplicates: false }
          )
      } catch (err) {
        console.log(`[pinnacle-sales-indexer] flowty lookup nft=${nftId} err:`, err instanceof Error ? err.message : String(err))
      }
    }

    const unresolvedCount = uniqueNftIds.filter((id) => !nftToEditionId.has(id)).length
    console.log(
      `[pinnacle-sales-indexer] edition resolution: total=${uniqueNftIds.length} resolved=${nftToEditionId.size} unresolved=${unresolvedCount} flowtyAttempted=${flowtyAttempted} flowtyResolved=${flowtyResolved}`
    )

    const rows = sales.map((s) => ({
      id: `${s.transactionId}_${s.nftID}`,
      edition_id: nftToEditionId.get(s.nftID) ?? null,
      nft_id: s.nftID,
      sale_price_usd: parseFloat(s.salePrice) || 0,
      serial_number: null,
      sold_at: s.blockTimestamp,
      source: "on-chain",
      buyer_address: s.commissionReceiver ?? null,
      seller_address: null,
    }))

    let inserted = 0
    let duped = 0
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100)
      const { error } = await (supabaseAdmin as any)
        .from("pinnacle_sales")
        .upsert(batch, { onConflict: "id", ignoreDuplicates: true })
      if (error) {
        if (error.code === "23505") {
          duped += batch.length
        } else {
          console.log("[pinnacle-sales-indexer] batch insert err:", error.message)
          for (const row of batch) {
            const { error: se } = await (supabaseAdmin as any)
              .from("pinnacle_sales")
              .upsert(row, { onConflict: "id", ignoreDuplicates: true })
            if (se) duped++
            else inserted++
          }
        }
      } else {
        inserted += batch.length
      }
    }

    const finalUnresolved = sales.filter((s) => !nftToEditionId.has(s.nftID)).length

    return NextResponse.json({
      ok: true,
      blocksScanned: targetHeight - lastBlock,
      eventsFound: sales.length,
      salesInserted: inserted,
      salesDuped: duped,
      salesUnresolved: finalUnresolved,
      flowtyAttempted,
      flowtyResolved,
      cursor: lastChunkEnd,
      elapsed: Date.now() - started,
    })
  } catch (err) {
    console.log("[pinnacle-sales-indexer] fatal:", err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: "Internal server error", details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

export async function GET(req: NextRequest) { return runIndexer(req) }
export async function POST(req: NextRequest) { return runIndexer(req) }
