import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import {
  FLOWTY_PINNACLE_ENDPOINT,
  FLOWTY_PINNACLE_HEADERS,
  PINNACLE_MARKETPLACE_URL,
  buildPinnacleEditionKey,
  parseStringifiedArray,
} from "@/lib/pinnacle/pinnacleTypes"

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const PAGE_SIZE = 100
const MAX_PAGES = 20
const FLOWTY_TIMEOUT_MS = 12_000

type FlowtyOrder = {
  state?: string
  salePrice?: string | number
  listingResourceID?: string
  storefrontAddress?: string
  blockTimestamp?: string | number
}

type FlowtyNft = {
  id?: string
  owner?: string
  orders?: FlowtyOrder[]
  nftView?: {
    traits?: { traits?: Array<{ name: string; value: string }> } | Array<{ name: string; value: string }>
  }
}

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

async function fetchFlowtyPage(offset: number): Promise<FlowtyNft[]> {
  try {
    const res = await fetch(FLOWTY_PINNACLE_ENDPOINT, {
      method: "POST",
      headers: FLOWTY_PINNACLE_HEADERS,
      body: JSON.stringify({ filters: { listingKind: "sale" }, offset, limit: PAGE_SIZE }),
      signal: AbortSignal.timeout(FLOWTY_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.log(`[pinnacle-listing-cache] page offset=${offset} HTTP ${res.status}`)
      return []
    }
    const json = await res.json() as { nfts?: FlowtyNft[]; data?: FlowtyNft[] }
    const items = json.nfts ?? json.data ?? []
    return Array.isArray(items) ? items : []
  } catch (e: any) {
    console.log(`[pinnacle-listing-cache] page offset=${offset} error: ${e?.message ?? "unknown"}`)
    return []
  }
}

function traitsOf(nft: FlowtyNft): Array<{ name: string; value: string }> {
  const t = nft?.nftView?.traits
  if (!t) return []
  if (Array.isArray(t)) return t
  if (Array.isArray((t as any).traits)) return (t as any).traits
  return []
}

function cheapestListedOrder(orders: FlowtyOrder[] | undefined): FlowtyOrder | null {
  if (!Array.isArray(orders) || orders.length === 0) return null
  let best: FlowtyOrder | null = null
  let bestPrice = Infinity
  for (const o of orders) {
    if (o.state !== "LISTED") continue
    const p = parseFloat(String(o.salePrice ?? "0"))
    if (!isFinite(p) || p <= 0) continue
    if (p < bestPrice) {
      bestPrice = p
      best = o
    }
  }
  return best
}

function mapNft(nft: FlowtyNft): any | null {
  const nftId = nft?.id ? String(nft.id) : ""
  if (!nftId) return null
  const order = cheapestListedOrder(nft.orders)
  if (!order) return null
  const price = parseFloat(String(order.salePrice ?? "0"))
  if (!isFinite(price) || price <= 0) return null

  const traits = traitsOf(nft)
  const traitMap = new Map<string, string>()
  for (const t of traits) traitMap.set(t.name, t.value)

  const royaltyCodes = parseStringifiedArray(traitMap.get("RoyaltyCodes"))
  const royaltyCode = royaltyCodes[0] ?? ""
  const variant = traitMap.get("Variant") ?? "Standard"
  const printing = parseInt(traitMap.get("Printing") ?? "1", 10) || 1
  if (!royaltyCode) return null

  const editionKey = buildPinnacleEditionKey(royaltyCode, variant, printing)
  const characterName = parseStringifiedArray(traitMap.get("Characters"))[0] ?? "Unknown"
  const franchise = parseStringifiedArray(traitMap.get("Franchises"))[0] ?? "Unknown"
  const setName = traitMap.get("SetName") ?? ""

  const listingResourceId = order.listingResourceID ? String(order.listingResourceID) : ""
  const storefrontAddress = order.storefrontAddress ? String(order.storefrontAddress) : ""
  const listedAt = order.blockTimestamp
    ? new Date(Number(order.blockTimestamp)).toISOString()
    : null

  return {
    id: nftId,
    edition_key: editionKey,
    character_name: characterName,
    franchise,
    variant_type: variant,
    set_name: setName,
    ask_price: price,
    owner: nft.owner ?? null,
    listing_resource_id: listingResourceId || null,
    storefront_address: storefrontAddress || null,
    buy_url: PINNACLE_MARKETPLACE_URL,
    listed_at: listedAt,
    cached_at: new Date().toISOString(),
  }
}

async function runAskOnlyFmv(): Promise<number> {
  try {
    const { data, error } = await supabase.rpc("pinnacle_fmv_from_listings")
    if (error) {
      console.log(`[pinnacle-listing-cache] pinnacle_fmv_from_listings error: ${error.message}`)
      return 0
    }
    const count = typeof data === "number" ? data : 0
    console.log(`[pinnacle-listing-cache] ASK_ONLY FMV snapshots created/updated: ${count}`)
    return count
  } catch (e: any) {
    console.log(`[pinnacle-listing-cache] pinnacle_fmv_from_listings exception: ${e?.message ?? "unknown"}`)
    return 0
  }
}

async function runSalesFmvRecalc(): Promise<number> {
  try {
    const { data, error } = await supabase.rpc("pinnacle_fmv_recalc_all")
    if (error) {
      console.log(`[pinnacle-listing-cache] pinnacle_fmv_recalc_all error: ${error.message}`)
      return 0
    }
    const count = typeof data === "number" ? data : 0
    console.log(`[pinnacle-listing-cache] SALES FMV snapshots recalculated: ${count}`)
    return count
  } catch (e: any) {
    console.log(`[pinnacle-listing-cache] pinnacle_fmv_recalc_all exception: ${e?.message ?? "unknown"}`)
    return 0
  }
}

async function run(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) return unauthorized()

  const started = Date.now()
  const raw: FlowtyNft[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE
    const items = await fetchFlowtyPage(offset)
    raw.push(...items)
    if (items.length < PAGE_SIZE) break
  }
  console.log(`[pinnacle-listing-cache] Fetched ${raw.length} raw NFTs from Flowty`)

  const rows: any[] = []
  const seen = new Set<string>()
  for (const nft of raw) {
    const mapped = mapNft(nft)
    if (!mapped) continue
    if (seen.has(mapped.id)) continue
    seen.add(mapped.id)
    rows.push(mapped)
  }
  console.log(`[pinnacle-listing-cache] Mapped ${rows.length} valid listings`)

  if (rows.length === 0) {
    return NextResponse.json({
      ok: true,
      message: "Flowty returned 0 mapped listings — preserving existing cache",
      fetched: raw.length,
      cached: 0,
      elapsed: Date.now() - started,
    })
  }

  const del = await supabase.from("pinnacle_cached_listings").delete().not("id", "is", null)
  if (del.error) console.log(`[pinnacle-listing-cache] delete error: ${del.error.message}`)

  let inserted = 0
  let errors = 0
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100)
    const { error } = await supabase.from("pinnacle_cached_listings").insert(chunk)
    if (error) {
      console.log(`[pinnacle-listing-cache] insert chunk ${i} error: ${error.message}`)
      errors++
      for (const single of chunk) {
        const { error: se } = await supabase.from("pinnacle_cached_listings").insert([single])
        if (!se) inserted++
      }
    } else {
      inserted += chunk.length
    }
  }

  const askOnlyFmvCount = await runAskOnlyFmv()
  const salesFmvCount = await runSalesFmvRecalc()

  return NextResponse.json({
    ok: true,
    fetched: raw.length,
    mapped: rows.length,
    cached: inserted,
    errors,
    askOnlyFmvCount,
    salesFmvCount,
    elapsed: Date.now() - started,
  })
}

export async function GET(req: NextRequest) { return run(req) }
export async function POST(req: NextRequest) { return run(req) }
