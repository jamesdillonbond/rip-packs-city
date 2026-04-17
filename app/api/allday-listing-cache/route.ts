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
// Dual-sort sweep constants. We fetch three pages sorted salePrice asc
// (captures the cheap/floor listings) and three sorted salePrice desc
// (captures the expensive tail that price-asc pagination never reaches).
// 3 × 24 × 2 = up to 144 listings per run after dedup by listing_resource_id.
const PAGE_LIMIT = 24
const SWEEP_OFFSETS = [0, 24, 48]
const INTER_PAGE_DELAY_MS = 200
const UPSERT_CHUNK = 50
const EDITION_LOOKUP_CHUNK = 100

type FlowtySort = { direction: "asc" | "desc"; path: "salePrice" }

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

async function fetchPage(offset: number, sort: FlowtySort) {
  const res = await fetch(FLOWTY_PROXY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${FLOWTY_PROXY_TOKEN}`,
    },
    body: JSON.stringify({
      contractAddress: AD_CONTRACT_ADDRESS,
      contractName: AD_CONTRACT_NAME,
      // Flowty's collection endpoint accepts sort inside the payload; the
      // flowty-proxy edge function forwards the payload unchanged.
      payload: { filters: {}, offset, limit: PAGE_LIMIT, sort },
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

const PIPELINE_NAME = "allday-listing-cache"
const COLLECTION_SLUG = "nfl_all_day"

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
  // Dedup by listing_resource_id (primary) — the same NFT can appear in both
  // sorts if it's mid-range, and using listing_resource_id is safer than
  // flow_id because the same flow_id could theoretically have two active
  // listings under rare conditions.
  const seenListingIds = new Set<string>()

  const sweeps: Array<{ label: string; sort: FlowtySort }> = [
    { label: "asc",  sort: { direction: "asc",  path: "salePrice" } },
    { label: "desc", sort: { direction: "desc", path: "salePrice" } },
  ]

  for (const sweep of sweeps) {
    for (const offset of SWEEP_OFFSETS) {
      const page = await fetchPage(offset, sweep.sort).catch((err) => {
        console.log(`[allday-listing-cache] Page sweep=${sweep.label} offset=${offset} failed: ${String(err)}`)
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

        seenListingIds.add(listingKey)
        rows.push({
          id: listingKey,
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
          listing_resource_id: listingKey,
          storefront_address: storefrontAddress,
          is_locked: false,
          listed_at: listedAt,
          cached_at: new Date().toISOString(),
          collection_id: AD_COLLECTION_ID,
          edition_external_id: editionId,
        })
      }

      await delay(INTER_PAGE_DELAY_MS)
    }
  }

  stats.totalListed = rows.length

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
  stats.editionsMapped = editionMap.size

  // Upsert first, then conditionally purge stale rows. Matches the Top Shot /
  // Golazos pattern — a failed Flowty sweep no longer wipes the entire cache
  // to 0 before the upsert runs.
  const runStartedAt = new Date(startedAt).toISOString()
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
      stats.upsertErrors += batch.length
    } else {
      stats.upserted += count ?? batch.length
    }
  }

  // Only purge stale AllDay rows if at least one new row was upserted; that
  // way a Flowty outage leaves the prior cache intact instead of wiping it.
  if (stats.upserted > 0) {
    const { error: delErr } = await supabaseAdmin
      .from("cached_listings")
      .delete()
      .eq("collection_id", AD_COLLECTION_ID)
      .eq("source", "flowty")
      .lt("cached_at", runStartedAt)
    if (delErr) {
      console.log(`[allday-listing-cache] stale purge error: ${delErr.message}`)
    }
  } else {
    console.log("[allday-listing-cache] 0 rows upserted — preserving prior cache")
  }

  // Regenerate ASK_ONLY FMV snapshots from cached listings, then refresh
  // sales-based FMV so editions with sales get SALES_ONLY / HIGH upgrades
  // alongside the listing-based ASK_ONLY rows created above.
  try {
    const { error } = await supabaseAdmin.rpc("fmv_from_cached_listings", {
      p_collection_id: AD_COLLECTION_ID,
    })
    if (error) {
      console.log(`[allday-listing-cache] fmv rpc error: ${error.message}`)
    } else {
      stats.fmvRpcCalled = true
    }
  } catch (err) {
    console.log(`[allday-listing-cache] fmv rpc threw: ${String(err)}`)
  }

  try {
    const { error } = await supabaseAdmin.rpc("fmv_from_sales", {
      p_collection_id: AD_COLLECTION_ID,
    })
    if (error) {
      console.log(`[allday-listing-cache] fmv_from_sales error: ${error.message}`)
    } else {
      stats.fmvSalesCalled = true
    }
  } catch (err) {
    console.log(`[allday-listing-cache] fmv_from_sales threw: ${String(err)}`)
  }

  } catch (err) {
    stats.ok = false
    stats.errorMsg = err instanceof Error ? err.message : String(err)
    console.log(`[allday-listing-cache] fatal: ${stats.errorMsg}`)
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
        `[allday-listing-cache] log_pipeline_run err: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    }
    console.log(
      `[allday-listing-cache] done: ${JSON.stringify({
        ...stats,
        durationMs: Date.now() - startedAt,
      })}`
    )
  }
}
