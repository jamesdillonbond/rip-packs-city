import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── NFL All Day listing cache ─────────────────────────────────────────────────
//
// Orchestrates the Flowty → cached_listings pipeline for NFL All Day by calling
// the Supabase flowty-proxy edge function (which sidesteps Flowty's IP filter),
// replaces the AD rows in cached_listings, and regenerates ASK_ONLY FMV
// snapshots via the fmv_from_cached_listings RPC.
// ─────────────────────────────────────────────────────────────────────────────

export const maxDuration = 300

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const AD_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const AD_CONTRACT_ADDRESS = "0xe4cf4bdc1751c65d"
const AD_CONTRACT_NAME = "AllDay"
const FLOWTY_PROXY_URL =
  "https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/flowty-proxy"
const FLOWTY_PROXY_TOKEN = "rippackscity2026"
const PAGE_LIMIT = 50
const INTER_PAGE_DELAY_MS = 200
const UPSERT_CHUNK = 50
const EDITION_LOOKUP_CHUNK = 100

type Trait = { name?: string; value?: unknown }

type Order = {
  state?: string
  listingResourceID?: string
  usdValue?: number | string | null
  valuations?: { blended?: { usdValue?: number | string | null } }
  storefrontAddress?: string | null
  providerAddress?: string | null
  blockTimestamp?: number | string | null
}

type NFT = {
  id?: string | number
  nftId?: string | number
  nftView?: {
    serial?: number | string
    traits?: { traits?: Trait[] }
    editions?: { infoList?: Array<{ max?: number | null }> }
  }
  card?: { images?: Array<{ url?: string }> }
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
  if (!hit) return null
  const v = hit.value
  return v === null || v === undefined ? null : String(v)
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === "number" ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

async function fetchPage(offset: number) {
  const res = await fetch(FLOWTY_PROXY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${FLOWTY_PROXY_TOKEN}`,
    },
    body: JSON.stringify({
      contractAddress: AD_CONTRACT_ADDRESS,
      contractName: AD_CONTRACT_NAME,
      payload: { filters: {}, offset, limit: PAGE_LIMIT },
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`flowty-proxy ${res.status}: ${text.slice(0, 200)}`)
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
    message: "allday-listing-cache started in background via after()",
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
      console.log(`[allday-listing-cache] Page offset=${offset} failed: ${String(err)}`)
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
      const nftIdRaw = nft.nftId ?? nft.id
      if (nftIdRaw === undefined || nftIdRaw === null) continue
      const nftIdStr = String(nftIdRaw)
      if (seenFlowIds.has(nftIdStr)) continue
      const listingResourceID = listedOrder.listingResourceID
      if (!listingResourceID) continue

      const traits = nft.nftView?.traits?.traits
      const editionId = traitValue(traits, "editionID")
      const serialNumber =
        toNumber(traitValue(traits, "serialNumber")) ??
        toNumber(nft.nftView?.serial)
      const editionTier = traitValue(traits, "editionTier")
      const setName = traitValue(traits, "setName")
      const seriesName = traitValue(traits, "seriesName")
      const teamName = traitValue(traits, "teamName")
      let playerName = traitValue(traits, "Player Name")
      if (!playerName) {
        const first = traitValue(traits, "playerFirstName")
        const last = traitValue(traits, "playerLastName")
        const joined = [first, last].filter(Boolean).join(" ").trim()
        playerName = joined || null
      }

      const circulation =
        toNumber(nft.nftView?.editions?.infoList?.[0]?.max) ?? null
      const thumbnail = nft.card?.images?.[0]?.url ?? null
      const askPrice = toNumber(listedOrder.usdValue)
      const rawFmv = toNumber(listedOrder.valuations?.blended?.usdValue)
      const fmv = rawFmv && rawFmv > 0 ? rawFmv : null
      const storefrontAddress =
        listedOrder.storefrontAddress ?? listedOrder.providerAddress ?? null
      const ts = listedOrder.blockTimestamp
      let listedAt: string | null = null
      if (ts !== null && ts !== undefined) {
        const ms = typeof ts === "number" ? ts : parseFloat(String(ts))
        if (Number.isFinite(ms)) listedAt = new Date(ms).toISOString()
      }
      const buyUrl = `https://www.flowty.io/asset/${AD_CONTRACT_ADDRESS}/${AD_CONTRACT_NAME}/NFT/${nftIdStr}?listingResourceID=${listingResourceID}`

      seenFlowIds.add(nftIdStr)
      rows.push({
        id: String(listingResourceID),
        flow_id: nftIdStr,
        moment_id: editionId ?? null,
        player_name: playerName,
        team_name: teamName,
        set_name: setName,
        series_name: seriesName,
        tier: editionTier,
        serial_number: serialNumber,
        circulation_count: circulation,
        ask_price: askPrice,
        fmv,
        source: "flowty",
        buy_url: buyUrl,
        thumbnail_url: thumbnail,
        listing_resource_id: String(listingResourceID),
        storefront_address: storefrontAddress,
        is_locked: false,
        listed_at: listedAt,
        cached_at: new Date().toISOString(),
        collection_id: AD_COLLECTION_ID,
        edition_external_id: editionId,
      })
    }

    if (nfts.length < PAGE_LIMIT) break
    if (seenFlowIds.size === prevSeenSize) break
    offset += PAGE_LIMIT
    if (reportedTotal !== null && offset >= reportedTotal) break
    await delay(INTER_PAGE_DELAY_MS)
  }

  const totalListed = rows.length

  // Batch-lookup edition UUIDs (currently unused in writes; cached_listings has
  // no edition_id column, but we expose mapped count in the summary).
  const editionIds = Array.from(
    new Set(rows.map((r) => r.edition_external_id).filter((x): x is string => !!x))
  )
  const editionMap = new Map<string, string>()
  for (let i = 0; i < editionIds.length; i += EDITION_LOOKUP_CHUNK) {
    const chunk = editionIds.slice(i, i + EDITION_LOOKUP_CHUNK)
    const { data, error } = await supabaseAdmin
      .from("editions")
      .select("id, external_id")
      .eq("collection_id", AD_COLLECTION_ID)
      .in("external_id", chunk)
    if (error) {
      console.log(`[allday-listing-cache] edition lookup error: ${error.message}`)
      continue
    }
    for (const row of data ?? []) {
      if (row.external_id && row.id) editionMap.set(row.external_id, row.id)
    }
  }
  const editionsMapped = editionMap.size

  // Wipe existing AD cached listings.
  const { error: delErr } = await supabaseAdmin
    .from("cached_listings")
    .delete()
    .eq("collection_id", AD_COLLECTION_ID)
  if (delErr) {
    console.log(`[allday-listing-cache] Delete failed: ${delErr.message}`)
    return
  }

  // Upsert in batches.
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
      console.log(
        `[allday-listing-cache] upsert batch ${i} failed: ${error.message}`
      )
      upsertErrors += batch.length
    } else {
      upserted += count ?? batch.length
    }
  }

  // Regenerate ASK_ONLY FMV snapshots.
  let fmvRpcCalled = false
  try {
    const { error } = await supabaseAdmin.rpc("fmv_from_cached_listings", {
      p_collection_id: AD_COLLECTION_ID,
    })
    if (error) {
      console.log(`[allday-listing-cache] fmv rpc error: ${error.message}`)
    } else {
      fmvRpcCalled = true
    }
  } catch (err) {
    console.log(`[allday-listing-cache] fmv rpc threw: ${String(err)}`)
  }

  console.log(
    `[allday-listing-cache] done: ${JSON.stringify({
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
