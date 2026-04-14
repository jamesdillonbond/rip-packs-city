import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── UFC Strike listing cache ─────────────────────────────────────────────────
//
// Paginates Flowty (Origin-header required), extracts listed UFC Strike NFTs,
// replaces the UFC rows in cached_listings, and regenerates ASK_ONLY FMV
// snapshots via the fmv_from_cached_listings RPC.
//
// UFC Strike has no LiveToken FMV (valuations.blended.usdValue is always 0)
// and no tier trait — tier is inferred from circulation count.
// ─────────────────────────────────────────────────────────────────────────────

export const maxDuration = 300

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const UFC_COLLECTION_ID = "9b4824a8-736d-4a96-b450-8dcc0c46b023"
const UFC_CONTRACT_ADDRESS = "0x329feb3ab062d289"
const UFC_CONTRACT_NAME = "UFC_NFT"
const FLOWTY_URL = `https://api2.flowty.io/collection/${UFC_CONTRACT_ADDRESS}/${UFC_CONTRACT_NAME}`
const PAGE_LIMIT = 24
const INTER_PAGE_DELAY_MS = 250
const UPSERT_CHUNK = 50
const EDITION_LOOKUP_CHUNK = 100

type Trait = { name?: string; value?: unknown }

type Order = {
  state?: string
  listingResourceID?: string
  salePrice?: number | string | null
  usdValue?: number | string | null
  storefrontAddress?: string | null
  providerAddress?: string | null
  blockTimestamp?: number | string | null
}

type NFT = {
  id?: string | number
  nftId?: string | number
  card?: {
    title?: string
    max?: string | number | null
    num?: string | number | null
    images?: Array<{ url?: string }>
  }
  nftView?: {
    serial?: number | string
    traits?: { traits?: Trait[] }
    editions?: { infoList?: Array<{ name?: string; number?: number | null; max?: number | null }> }
  }
  orders?: Order[]
}

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function traitValue(traits: Trait[] | undefined, name: string): string | null {
  if (!traits) return null
  const hit = traits.find((t) => t?.name === name)
  if (!hit || hit.value === null || hit.value === undefined) return null
  return String(hit.value)
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === "number" ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

function inferTier(circulation: number | null): string {
  if (circulation === null) return "FANDOM"
  if (circulation <= 10) return "ULTIMATE"
  if (circulation <= 99) return "CHAMPION"
  if (circulation <= 999) return "CHALLENGER"
  if (circulation <= 25000) return "CONTENDER"
  return "FANDOM"
}

function slugify(name: string, max: number | null): string {
  const clean = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return max !== null ? `${clean}-${max}` : clean
}

async function fetchPage(offset: number) {
  const res = await fetch(FLOWTY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://www.flowty.io",
    },
    body: JSON.stringify({ filters: {}, offset, limit: PAGE_LIMIT }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`flowty ${res.status}: ${text.slice(0, 200)}`)
  }
  return (await res.json()) as { nfts?: NFT[]; total?: number }
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || (bearer !== TOKEN && urlToken !== TOKEN)) return unauthorized()

  after(async () => {
    await runListingCache()
  })

  return NextResponse.json({
    status: "accepted",
    message: "ufc-listing-cache started in background via after()",
    startedAt: new Date().toISOString(),
  })
}

async function runListingCache() {
  const startedAt = Date.now()

  type Row = {
    id: string
    flow_id: string
    moment_id: string | null
    player_name: string | null
    team_name: string | null
    set_name: string | null
    series_name: string | null
    tier: string | null
    serial_number: number | null
    circulation_count: number | null
    ask_price: number | null
    fmv: number | null
    source: string
    buy_url: string
    thumbnail_url: string | null
    listing_resource_id: string
    storefront_address: string | null
    is_locked: boolean
    listed_at: string | null
    cached_at: string
    collection_id: string
    edition_external_id: string | null
  }

  const rows: Row[] = []
  const seenFlowIds = new Set<string>()
  let totalFetched = 0
  let offset = 0

  while (true) {
    const page = await fetchPage(offset).catch((err) => {
      console.log(`[ufc-listing-cache] Page offset=${offset} failed: ${String(err)}`)
      return null
    })
    if (!page) break
    const nfts = Array.isArray(page.nfts) ? page.nfts : []
    totalFetched += nfts.length
    const reportedTotal = typeof page.total === "number" ? page.total : null
    const prevSeenSize = seenFlowIds.size

    for (const nft of nfts) {
      const orders = Array.isArray(nft.orders) ? nft.orders : []
      const listedOrder = orders.find((o) => o?.state === "LISTED")
      if (!listedOrder) continue

      const nftIdRaw = nft.nftId ?? nft.id ?? nft.card?.num
      if (nftIdRaw === undefined || nftIdRaw === null) continue
      const nftIdStr = String(nftIdRaw)
      if (seenFlowIds.has(nftIdStr)) continue

      const listingResourceID = listedOrder.listingResourceID
      if (!listingResourceID) continue

      const traits = nft.nftView?.traits?.traits
      const fighterName = traitValue(traits, "ATHLETE 1")

      const editionInfo = nft.nftView?.editions?.infoList?.[0]
      const editionName = (editionInfo?.name ?? nft.card?.title ?? "").trim()
      if (!editionName) continue

      const serialNumber =
        toNumber(editionInfo?.number) ??
        null
      const circulation =
        toNumber(editionInfo?.max) ??
        toNumber(nft.card?.max) ??
        null

      const tier = inferTier(circulation)
      const externalId = slugify(editionName, circulation)

      const thumbnail = nft.card?.images?.[0]?.url ?? null
      const askPrice = toNumber(listedOrder.salePrice) ?? toNumber(listedOrder.usdValue)
      const storefrontAddress =
        listedOrder.storefrontAddress ?? listedOrder.providerAddress ?? null

      const ts = listedOrder.blockTimestamp
      let listedAt: string | null = null
      if (ts !== null && ts !== undefined) {
        const ms = typeof ts === "number" ? ts : parseFloat(String(ts))
        if (Number.isFinite(ms)) listedAt = new Date(ms).toISOString()
      }

      const buyUrl = `https://www.flowty.io/asset/${UFC_CONTRACT_ADDRESS}/${UFC_CONTRACT_NAME}/NFT/${nftIdStr}?listingResourceID=${listingResourceID}`

      seenFlowIds.add(nftIdStr)
      rows.push({
        id: String(listingResourceID),
        flow_id: nftIdStr,
        moment_id: externalId,
        player_name: fighterName,
        team_name: null,
        set_name: null,
        series_name: null,
        tier,
        serial_number: serialNumber,
        circulation_count: circulation,
        ask_price: askPrice,
        fmv: null,
        source: "flowty",
        buy_url: buyUrl,
        thumbnail_url: thumbnail,
        listing_resource_id: String(listingResourceID),
        storefront_address: storefrontAddress,
        is_locked: false,
        listed_at: listedAt,
        cached_at: new Date().toISOString(),
        collection_id: UFC_COLLECTION_ID,
        edition_external_id: externalId,
      })
    }

    if (nfts.length < PAGE_LIMIT) break
    if (seenFlowIds.size === prevSeenSize) break
    offset += PAGE_LIMIT
    if (reportedTotal !== null && offset >= reportedTotal) break
    await delay(INTER_PAGE_DELAY_MS)
  }

  const totalListed = rows.length

  const editionIds = Array.from(
    new Set(rows.map((r) => r.edition_external_id).filter((x): x is string => !!x))
  )
  const editionMap = new Map<string, string>()
  for (let i = 0; i < editionIds.length; i += EDITION_LOOKUP_CHUNK) {
    const chunk = editionIds.slice(i, i + EDITION_LOOKUP_CHUNK)
    const { data, error } = await supabaseAdmin
      .from("editions")
      .select("id, external_id")
      .eq("collection_id", UFC_COLLECTION_ID)
      .in("external_id", chunk)
    if (error) {
      console.log(`[ufc-listing-cache] edition lookup error: ${error.message}`)
      continue
    }
    for (const row of data ?? []) {
      if (row.external_id && row.id) editionMap.set(row.external_id, row.id)
    }
  }
  const editionsMapped = editionMap.size

  // Wipe existing UFC cached listings.
  const { error: delErr } = await supabaseAdmin
    .from("cached_listings")
    .delete()
    .eq("collection_id", UFC_COLLECTION_ID)
  if (delErr) {
    console.log(`[ufc-listing-cache] Delete failed: ${delErr.message}`)
    return
  }

  let upserted = 0
  let upsertErrors = 0
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const batch = rows.slice(i, i + UPSERT_CHUNK).map((r) => {
      const { edition_external_id: _drop, ...rest } = r
      return rest
    })
    const { error, count } = await supabaseAdmin
      .from("cached_listings")
      .upsert(batch, { onConflict: "flow_id", count: "exact" })
    if (error) {
      console.log(`[ufc-listing-cache] upsert batch ${i} failed: ${error.message}`)
      upsertErrors += batch.length
    } else {
      upserted += count ?? batch.length
    }
  }

  let fmvRpcCalled = false
  try {
    const { error } = await supabaseAdmin.rpc("fmv_from_cached_listings", {
      p_collection_id: UFC_COLLECTION_ID,
    })
    if (error) {
      console.log(`[ufc-listing-cache] fmv rpc error: ${error.message}`)
    } else {
      fmvRpcCalled = true
    }
  } catch (err) {
    console.log(`[ufc-listing-cache] fmv rpc threw: ${String(err)}`)
  }

  console.log(
    `[ufc-listing-cache] done: ${JSON.stringify({
      totalFetched,
      totalListed,
      upserted,
      upsertErrors,
      editionsMapped,
      fmvRpcCalled,
      durationMs: Date.now() - startedAt,
    })}`
  )
}
