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
const FLOWTY_PROXY_TOKEN = process.env.FLOWTY_PROXY_TOKEN
if (!FLOWTY_PROXY_TOKEN) {
  throw new Error("FLOWTY_PROXY_TOKEN env var is required")
}
const AD_GQL_PROXY = process.env.AD_PROXY_URL ?? ""
const AD_GQL_SECRET = process.env.AD_PROXY_SECRET ?? ""
const AD_GQL_FALLBACK = "https://nflallday.com/consumer/graphql"
const AD_GQL_PAGE_SIZE = 100
const AD_GQL_MAX_PAGES = 70
const AD_GQL_PAGE_TIMEOUT_MS = 8000
const FMV_UPSERT_CHUNK = 500
// Dual-sort sweep constants. We fetch up to 10 pages sorted salePrice asc
// (captures the cheap/floor listings) and 10 sorted salePrice desc (captures
// the expensive tail that price-asc pagination never reaches), at 50 listings
// per page. 10 × 50 × 2 = up to 1000 listings per run before dedup; in
// practice dedup collapses overlap to a few hundred unique listings. The
// previous PAGE_LIMIT=24 with only 3 offsets was capping runs at ~48
// listings, well below the actual AllDay marketplace depth.
//
// Each sweep breaks early as soon as a page returns < PAGE_LIMIT rows
// (signals end-of-data for that sort direction), so smaller marketplaces
// don't pay the full 20-page cost.
const PAGE_LIMIT = 50
const SWEEP_OFFSETS = [0, 50, 100, 150, 200, 250, 300, 350, 400, 450]
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

type AlldayMarketRow = {
  edition_flow_id: string
  lowest_price: string
  average_sale: string
  total_listings: number
}

const AD_GQL_QUERY = `query SearchMarketplaceEditions($first: Int!, $after: String, $sortBy: MarketplaceEditionSortType) {
  searchMarketplaceEditions(input: { first: $first, after: $after, sortBy: $sortBy }) {
    totalCount
    pageInfo { endCursor hasNextPage }
    edges {
      node {
        editionFlowID
        lowestPrice
        averageSale
        totalListings
      }
    }
  }
}`

async function fetchAlldayMarketplaceAllPages(): Promise<AlldayMarketRow[]> {
  const url = AD_GQL_PROXY || AD_GQL_FALLBACK
  const useProxy = !!AD_GQL_PROXY
  const rows: AlldayMarketRow[] = []
  let cursor: string | null = null

  for (let pageNum = 0; pageNum < AD_GQL_MAX_PAGES; pageNum++) {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (useProxy && AD_GQL_SECRET) headers["X-Proxy-Secret"] = AD_GQL_SECRET

    const controller = new AbortController()
    const to = setTimeout(() => controller.abort(), AD_GQL_PAGE_TIMEOUT_MS)

    let body: any
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: AD_GQL_QUERY,
          variables: {
            first: AD_GQL_PAGE_SIZE,
            after: cursor,
            sortBy: "LISTED_DATE_DESC",
          },
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const txt = await res.text().catch(() => "")
        console.log(
          `[allday-listing-cache] GQL page ${pageNum} http ${res.status}: ${txt.slice(0, 200)}`
        )
        break
      }
      body = await res.json()
    } catch (err) {
      console.log(
        `[allday-listing-cache] GQL page ${pageNum} fetch error: ${String(err)}`
      )
      break
    } finally {
      clearTimeout(to)
    }

    const data = body?.data?.searchMarketplaceEditions
    if (!data) {
      const errs = body?.errors ? JSON.stringify(body.errors).slice(0, 200) : ""
      console.log(
        `[allday-listing-cache] GQL page ${pageNum} missing data ${errs}`
      )
      break
    }

    const edges = Array.isArray(data.edges) ? data.edges : []
    for (const edge of edges) {
      const node = edge?.node
      if (!node?.editionFlowID) continue
      const totalListingsRaw = node.totalListings
      const totalListings =
        typeof totalListingsRaw === "number"
          ? totalListingsRaw
          : parseInt(String(totalListingsRaw ?? 0), 10) || 0
      rows.push({
        edition_flow_id: String(node.editionFlowID),
        lowest_price: node.lowestPrice != null ? String(node.lowestPrice) : "",
        average_sale: node.averageSale != null ? String(node.averageSale) : "",
        total_listings: totalListings,
      })
    }

    if (!data.pageInfo?.hasNextPage) break
    const next = data.pageInfo.endCursor
    if (!next) break
    cursor = String(next)
  }

  return rows
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
      // listingKind:"sale" matches the Pinnacle pattern — every returned NFT
      // is guaranteed to have an active sale order, so PAGE_LIMIT rows
      // translate ~1:1 to listings instead of being filtered down by the
      // state==="LISTED" check below.
      payload: { filters: { listingKind: "sale" }, offset, limit: PAGE_LIMIT, sort },
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
    fmv_populated: {
      upserted: 0,
      skipped: 0,
      no_edition: 0,
      editions_fetched: 0,
    },
    badge_low_ask_updated: 0,
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
      // Stop walking deeper into this sort direction once a page returns no
      // NFTs at all — the marketplace doesn't have any more listings under
      // this sort, and further offsets will also be empty.
      if (nfts.length === 0) break

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

      // Short page = end of data for this sort direction; stop paginating it.
      if (nfts.length < PAGE_LIMIT) break

      await delay(INTER_PAGE_DELAY_MS)
    }
  }

  stats.totalListed = rows.length

  // Dedup by flow_id before upsert. onConflict: 'flow_id' rejects the whole
  // batch when two VALUES rows share the conflict key, and the dual-sort
  // sweep can produce the same nftId under different listing_resource_ids.
  // Keep the row with the lower ask_price per flow_id.
  const byFlowId = new Map<string, Row>()
  for (const row of rows) {
    const prev = byFlowId.get(row.flow_id)
    if (!prev) {
      byFlowId.set(row.flow_id, row)
      continue
    }
    const prevAsk = prev.ask_price
    const nextAsk = row.ask_price
    if (nextAsk != null && (prevAsk == null || nextAsk < prevAsk)) {
      byFlowId.set(row.flow_id, row)
    }
  }
  const dedupedRows = Array.from(byFlowId.values())

  // Batch-lookup edition UUIDs (currently unused in writes; cached_listings has
  // no edition_id column, but we expose mapped count in the summary).
  const editionIds = Array.from(
    new Set(dedupedRows.map((r) => r.edition_external_id).filter((x): x is string => !!x))
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
  for (let i = 0; i < dedupedRows.length; i += UPSERT_CHUNK) {
    const batch = dedupedRows.slice(i, i + UPSERT_CHUNK).map((r) => {
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

  // Phase 2: populate marketplace FMV snapshots from the AllDay GQL marketplace
  // endpoint. Best-effort — failures here must not fail the overall pipeline.
  try {
    const marketRows = await fetchAlldayMarketplaceAllPages()
    stats.fmv_populated.editions_fetched = marketRows.length
    if (marketRows.length > 0) {
      for (let i = 0; i < marketRows.length; i += FMV_UPSERT_CHUNK) {
        const chunk = marketRows.slice(i, i + FMV_UPSERT_CHUNK)
        const { data, error } = await supabaseAdmin.rpc(
          "upsert_allday_marketplace_fmv",
          { p_rows: JSON.stringify(chunk) as any }
        )
        if (error) {
          console.log(
            `[allday-listing-cache] upsert_allday_marketplace_fmv chunk ${i} error: ${error.message}`
          )
          continue
        }
        const row = Array.isArray(data) ? data[0] : data
        if (row && typeof row === "object") {
          stats.fmv_populated.upserted += Number(row.upserted ?? 0) || 0
          stats.fmv_populated.skipped += Number(row.skipped ?? 0) || 0
          stats.fmv_populated.no_edition += Number(row.no_edition ?? 0) || 0
        }
      }
      console.log(
        `[allday-listing-cache] marketplace fmv populated: ${JSON.stringify(
          stats.fmv_populated
        )}`
      )

      // Backfill badge_editions.low_ask using the same per-edition data we
      // already have in hand. badge_editions.external_id == editionFlowID for
      // AllDay, so the join is direct. Best-effort — failure here is not
      // fatal to the pipeline.
      try {
        const badgePayload = marketRows
          .map((m) => {
            const lowAsk =
              m.lowest_price && m.lowest_price.trim() !== ""
                ? Number(m.lowest_price)
                : null
            if (lowAsk == null || !Number.isFinite(lowAsk) || lowAsk <= 0) return null
            return { external_id: m.edition_flow_id, low_ask: lowAsk }
          })
          .filter((x): x is { external_id: string; low_ask: number } => x !== null)
        console.log(
          `[allday-badge-aggregator] payload size=${badgePayload.length} sample=${JSON.stringify(badgePayload.slice(0, 3))}`
        )
        if (badgePayload.length > 0) {
          const { data, error } = await supabaseAdmin.rpc(
            "update_badge_low_ask_by_external",
            {
              p_collection_id: AD_COLLECTION_ID,
              p_data: badgePayload as any,
            }
          )
          if (error) {
            console.log(
              `[allday-listing-cache] update_badge_low_ask_by_external error: ${error.message}`
            )
          } else {
            stats.badge_low_ask_updated = Number(data ?? 0) || 0
            console.log(
              `[allday-listing-cache] badge_editions.low_ask updated: ${stats.badge_low_ask_updated} of ${badgePayload.length} candidates`
            )
          }
        }
      } catch (err) {
        console.log(
          `[allday-listing-cache] badge low_ask update threw (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    } else {
      console.log("[allday-listing-cache] marketplace fetch returned 0 rows")
    }
  } catch (err) {
    console.log(
      `[allday-listing-cache] marketplace fmv phase threw (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`
    )
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
          fmv_populated: stats.fmv_populated,
          badge_low_ask_updated: stats.badge_low_ask_updated,
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

  return { ...stats, durationMs: Date.now() - startedAt, startedAt: startedAtIso }
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || (bearer !== TOKEN && urlToken !== TOKEN)) return unauthorized()

  const result = await runListingCache()
  return NextResponse.json(result)
}
