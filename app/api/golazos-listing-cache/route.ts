import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── LaLiga Golazos listing cache ──────────────────────────────────────────────
//
// Mirrors allday-listing-cache: routes Flowty fetches through the Supabase
// flowty-proxy edge function (Vercel IPs are blocked by Flowty), then upserts
// rows into cached_listings keyed by listingResourceID.
//
// Created because the generic /api/listing-cache route fetches Flowty directly
// and was returning empty/blocked for Golazos, leaving cached_listings at 0
// rows for the laliga-golazos collection.
// ─────────────────────────────────────────────────────────────────────────────

export const maxDuration = 300

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const GZ_COLLECTION_ID = "06248cc4-b85f-47cd-af67-1855d14acd75"
const GZ_CONTRACT_ADDRESS = "0x87ca73a41bb50ad5"
const GZ_CONTRACT_NAME = "Golazos"
const FLOWTY_PROXY_URL =
  "https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/flowty-proxy"
const FLOWTY_PROXY_TOKEN = process.env.FLOWTY_PROXY_TOKEN
if (!FLOWTY_PROXY_TOKEN) {
  throw new Error("FLOWTY_PROXY_TOKEN env var is required")
}
const PAGE_LIMIT = 50
// Dual-sort sweep: cheap listings dominate the floor when sorted salePrice asc,
// which is why pre-sweep Golazos was pinned at the $0.14–$1 band with zero
// RARE/LEGENDARY representation. A parallel salePrice desc sweep pulls the
// expensive tail; dedup by listing_resource_id across both passes.
const SWEEP_OFFSETS = [0, 50, 100]
const INTER_PAGE_DELAY_MS = 200
const UPSERT_CHUNK = 50
const EDITION_LOOKUP_CHUNK = 100

type FlowtySort = { direction: "asc" | "desc"; path: "salePrice" }

type Trait = { name?: string; value?: unknown }

type Order = {
  state?: string
  listingResourceID?: string
  usdValue?: number | string | null
  salePrice?: number | string | null
  valuations?: { blended?: { usdValue?: number | string | null } }
  storefrontAddress?: string | null
  providerAddress?: string | null
  blockTimestamp?: number | string | null
}

type NFT = {
  id?: string | number
  nftId?: string | number
  card?: { title?: string; num?: string | number; max?: string | number; images?: Array<{ url?: string }> }
  nftView?: {
    serial?: number | string
    traits?: { traits?: Trait[] } | Trait[]
    editions?: { infoList?: Array<{ max?: number | null }> }
  }
  orders?: Order[]
}

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function traitMulti(traits: Trait[] | undefined, ...names: string[]): string | null {
  if (!Array.isArray(traits)) return null
  for (const name of names) {
    const hit = traits.find((t) => t?.name === name)
    if (hit && hit.value !== null && hit.value !== undefined && String(hit.value).trim() !== "") {
      return String(hit.value).trim()
    }
  }
  return null
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === "number" ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

async function fetchPage(offset: number, sort?: FlowtySort) {
  const res = await fetch(FLOWTY_PROXY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${FLOWTY_PROXY_TOKEN}`,
    },
    body: JSON.stringify({
      contractAddress: GZ_CONTRACT_ADDRESS,
      contractName: GZ_CONTRACT_NAME,
      payload: sort
        ? { filters: {}, offset, limit: PAGE_LIMIT, sort }
        : { filters: {}, offset, limit: PAGE_LIMIT },
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
    message: "golazos-listing-cache started in background via after()",
    startedAt: new Date().toISOString(),
  })
}

export async function POST(req: NextRequest) {
  return GET(req)
}

const PIPELINE_NAME = "golazos-listing-cache"
const COLLECTION_SLUG = "laliga_golazos"

async function runListingCache() {
  const startedAt = Date.now()
  const startedAtIso = new Date(startedAt).toISOString()
  const stats = {
    ok: true,
    errorMsg: null as string | null,
    totalFetched: 0,
    totalListed: 0,
    upserted: 0,
    upsertErrors: 0,
    editionsMapped: 0,
    fmvRpcCalled: false,
    fmvSalesCalled: false,
  }

  try {

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
  // Dedup by listing_resource_id — the same NFT can appear in both the asc
  // and desc sweeps if it sits mid-range, and listing_resource_id is safer
  // than nft_id because the same flow_id could theoretically back two
  // simultaneous listings.
  const seenListingIds = new Set<string>()
  const seenFlowIds = new Set<string>()

  const sweeps: Array<{ label: string; sort: FlowtySort }> = [
    { label: "asc",  sort: { direction: "asc",  path: "salePrice" } },
    { label: "desc", sort: { direction: "desc", path: "salePrice" } },
  ]

  for (const sweep of sweeps) {
    for (const offset of SWEEP_OFFSETS) {
      const page = await fetchPage(offset, sweep.sort).catch((err) => {
        console.log(
          `[golazos-listing-cache] sweep=${sweep.label} offset=${offset} failed: ${String(err)}`
        )
        return null
      })
      if (!page) continue
      const nfts = Array.isArray(page.nfts) ? page.nfts : []
      stats.totalFetched += nfts.length

      for (const nft of nfts) {
        const orders = Array.isArray(nft.orders) ? nft.orders : []
        const listedOrder = orders.find((o) => o?.state === "LISTED")
        if (!listedOrder) continue
        const listingResourceID = listedOrder.listingResourceID
        if (!listingResourceID) continue
        const listingKey = String(listingResourceID)
        if (seenListingIds.has(listingKey)) continue
        const nftIdRaw = nft.nftId ?? nft.id
        if (nftIdRaw === undefined || nftIdRaw === null) continue
        const nftIdStr = String(nftIdRaw)
        if (seenFlowIds.has(nftIdStr)) continue

      // Normalize traits — Golazos uses nftView.traits.traits like AllDay
      let traits: Trait[] | undefined
      const rawTraits = nft.nftView?.traits
      if (rawTraits) {
        if (Array.isArray(rawTraits)) traits = rawTraits as Trait[]
        else if (Array.isArray((rawTraits as { traits?: Trait[] }).traits)) {
          traits = (rawTraits as { traits?: Trait[] }).traits
        }
      }

      // Golazos doesn't expose editionID directly; PlayDataID is the closest
      // stable per-edition identifier in Flowty's payload.
      const editionId =
        traitMulti(traits, "editionID", "EditionID", "editionFlowID") ??
        traitMulti(traits, "PlayDataID")
      const serialNumber =
        toNumber(traitMulti(traits, "serialNumber", "SerialNumber")) ??
        toNumber(nft.nftView?.serial) ??
        toNumber(nft.card?.num)
      const editionTier = traitMulti(traits, "editionTier", "Tier")
      const setName = traitMulti(traits, "setName", "SetName", "Set Name")
      const seriesName = traitMulti(traits, "seriesName", "SeriesName")
      const teamName =
        traitMulti(traits, "teamName", "TeamName", "MatchHighlightedTeam", "MatchHomeTeam")

      // Player name: prefer card.title, then trait fallbacks
      let playerName = nft.card?.title ? String(nft.card.title).trim() : null
      if (!playerName) {
        const first = traitMulti(traits, "PlayerFirstName", "playerFirstName")
        const last = traitMulti(traits, "PlayerLastName", "playerLastName")
        const joined = [first, last].filter(Boolean).join(" ").trim()
        playerName = joined || traitMulti(traits, "PlayerJerseyName", "Player Name") || null
      }
      if (!playerName) continue

      const circulation =
        toNumber(nft.nftView?.editions?.infoList?.[0]?.max) ??
        toNumber(nft.card?.max) ??
        null
      const thumbnail = nft.card?.images?.[0]?.url ?? null
      const askPrice = toNumber(listedOrder.salePrice) ?? toNumber(listedOrder.usdValue)
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
      const buyUrl = `https://www.flowty.io/asset/${GZ_CONTRACT_ADDRESS}/${GZ_CONTRACT_NAME}/NFT/${nftIdStr}?listingResourceID=${listingResourceID}`

      seenFlowIds.add(nftIdStr)
      seenListingIds.add(listingKey)
      rows.push({
        id: String(listingResourceID),
        flow_id: nftIdStr,
        moment_id: editionId ?? null,
        player_name: playerName,
        team_name: teamName,
        set_name: setName,
        series_name: seriesName,
        tier: editionTier ? editionTier.toUpperCase() : null,
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
        collection_id: GZ_COLLECTION_ID,
        edition_external_id: editionId,
      })
      }

      await delay(INTER_PAGE_DELAY_MS)
    }
  }

  stats.totalListed = rows.length

  const editionIds = Array.from(
    new Set(rows.map((r) => r.edition_external_id).filter((x): x is string => !!x))
  )
  const editionMap = new Map<string, string>()
  for (let i = 0; i < editionIds.length; i += EDITION_LOOKUP_CHUNK) {
    const chunk = editionIds.slice(i, i + EDITION_LOOKUP_CHUNK)
    const { data, error } = await supabaseAdmin
      .from("editions")
      .select("id, external_id")
      .eq("collection_id", GZ_COLLECTION_ID)
      .in("external_id", chunk)
    if (error) {
      console.log(`[golazos-listing-cache] edition lookup error: ${error.message}`)
      continue
    }
    for (const row of data ?? []) {
      if (row.external_id && row.id) editionMap.set(row.external_id, row.id)
    }
  }
  stats.editionsMapped = editionMap.size

  // Upsert first, then conditionally purge stale rows — same safety as
  // the AD route: never wipe to 0 if every chunk errors.
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const batch = rows.slice(i, i + UPSERT_CHUNK).map((r) => {
      const { edition_external_id: _drop, ...rest } = r
      return rest
    })
    const { error, count } = await supabaseAdmin
      .from("cached_listings")
      .upsert(batch, { onConflict: "flow_id", count: "exact" })
    if (error) {
      console.log(`[golazos-listing-cache] upsert batch ${i} failed: ${error.message}`)
      stats.upsertErrors += batch.length
    } else {
      stats.upserted += count ?? batch.length
    }
  }

  if (stats.upserted > 0) {
    const runStartedAt = new Date(startedAt).toISOString()
    const { error: delErr } = await supabaseAdmin
      .from("cached_listings")
      .delete()
      .eq("collection_id", GZ_COLLECTION_ID)
      .eq("source", "flowty")
      .lt("cached_at", runStartedAt)
    if (delErr) {
      console.log(`[golazos-listing-cache] stale purge error: ${delErr.message}`)
    }
  } else {
    console.log("[golazos-listing-cache] 0 rows upserted — preserving prior cache")
  }

  // Regenerate ASK_ONLY FMV snapshots for Golazos, then refresh sales-based
  // FMV so editions with sales get SALES_ONLY / HIGH upgrades alongside the
  // listing-based ASK_ONLY rows created above.
  try {
    const { error } = await supabaseAdmin.rpc("fmv_from_cached_listings", {
      p_collection_id: GZ_COLLECTION_ID,
    })
    if (error) {
      console.log(`[golazos-listing-cache] fmv rpc error: ${error.message}`)
    } else {
      stats.fmvRpcCalled = true
    }
  } catch (err) {
    console.log(`[golazos-listing-cache] fmv rpc threw: ${String(err)}`)
  }

  try {
    const { error } = await supabaseAdmin.rpc("fmv_from_sales", {
      p_collection_id: GZ_COLLECTION_ID,
    })
    if (error) {
      console.log(`[golazos-listing-cache] fmv_from_sales error: ${error.message}`)
    } else {
      stats.fmvSalesCalled = true
    }
  } catch (err) {
    console.log(`[golazos-listing-cache] fmv_from_sales threw: ${String(err)}`)
  }

  } catch (err) {
    stats.ok = false
    stats.errorMsg = err instanceof Error ? err.message : String(err)
    console.log(`[golazos-listing-cache] fatal: ${stats.errorMsg}`)
  } finally {
    try {
      await (supabaseAdmin as any).rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAtIso,
        p_rows_found: stats.totalListed,
        p_rows_written: stats.upserted,
        p_rows_skipped: stats.upsertErrors,
        p_ok: stats.ok,
        p_error: stats.errorMsg,
        p_collection_slug: COLLECTION_SLUG,
        p_cursor_before: null,
        p_cursor_after: null,
        p_extra: {
          total_fetched: stats.totalFetched,
          editions_mapped: stats.editionsMapped,
          fmv_rpc_called: stats.fmvRpcCalled,
          fmv_sales_called: stats.fmvSalesCalled,
          duration_ms: Date.now() - startedAt,
        },
      })
    } catch (e) {
      console.log(
        `[golazos-listing-cache] log_pipeline_run err: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    }
    console.log(
      `[golazos-listing-cache] done: ${JSON.stringify({
        ...stats,
        durationMs: Date.now() - startedAt,
      })}`
    )
  }
}
