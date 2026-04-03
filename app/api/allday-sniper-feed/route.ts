import { NextResponse } from "next/server"
import { createClient, SupabaseClient } from "@supabase/supabase-js"
import { getOrSetCache } from "@/lib/cache"
import { z } from "zod"

// ─── Types ────────────────────────────────────────────────────────────────────

interface RawListing {
  id: string
  flowRetailPrice?: { value: string }
  marketplacePrice?: number
  setPlay: {
    setID: number
    playID: number
  }
  serialNumber: number
  circulationCount: number
  setName?: string
  momentTier?: string
  momentTitle?: string
  playerName?: string
  teamAtMomentNbaId?: string
  isLocked?: boolean
  storefrontListingID?: string
  sellerAddress?: string
  listingOrderID?: string
  setSeriesNumber?: number
}

interface FmvRow {
  editionKey: string
  fmv: number
  floorPriceUsd: number | null
  confidence: string
}

export interface SniperDeal {
  flowId: string
  momentId: string
  editionKey: string
  playerName: string
  teamName: string
  setName: string
  seriesName: string
  tier: string
  serial: number
  circulationCount: number
  askPrice: number
  baseFmv: number
  adjustedFmv: number
  discount: number
  confidence: string
  serialMult: number
  isSpecialSerial: boolean
  isJersey: boolean
  serialSignal: string | null
  thumbnailUrl: string | null
  isLocked: boolean
  buyUrl: string
  source: "nfl_all_day" | "flowty"
}

// ─── Constants ────────────────────────────────────────────────────────────────

const AD_GQL = "https://public-api.nflallday.com/graphql"
const GQL_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "User-Agent": "sports-collectible-tool/0.1",
}

const FLOWTY_ENDPOINT = "https://api2.flowty.io/collection/0xe4cf4bdc1751c65d/AllDay"
const FLOWTY_HEADERS = {
  "Content-Type": "application/json",
  "Origin": "https://www.flowty.io",
  "Referer": "https://www.flowty.io/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36",
}

const NFL_TEAMS: Record<string, string> = {
  "Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL", "Baltimore Ravens": "BAL",
  "Buffalo Bills": "BUF", "Carolina Panthers": "CAR", "Chicago Bears": "CHI",
  "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE", "Dallas Cowboys": "DAL",
  "Denver Broncos": "DEN", "Detroit Lions": "DET", "Green Bay Packers": "GB",
  "Houston Texans": "HOU", "Indianapolis Colts": "IND", "Jacksonville Jaguars": "JAX",
  "Kansas City Chiefs": "KC", "Las Vegas Raiders": "LV", "Los Angeles Chargers": "LAC",
  "Los Angeles Rams": "LAR", "Miami Dolphins": "MIA", "Minnesota Vikings": "MIN",
  "New England Patriots": "NE", "New Orleans Saints": "NO", "New York Giants": "NYG",
  "New York Jets": "NYJ", "Philadelphia Eagles": "PHI", "Pittsburgh Steelers": "PIT",
  "San Francisco 49ers": "SF", "Seattle Seahawks": "SEA", "Tampa Bay Buccaneers": "TB",
  "Tennessee Titans": "TEN", "Washington Commanders": "WAS",
}

const SERIES_NAMES: Record<number, string> = {
  1: "S1", 2: "S2", 3: "S3", 4: "S4", 5: "S5", 6: "S6",
}

// ─── Serial premium model ─────────────────────────────────────────────────────

function serialMultiplier(
  serial: number,
  circulationCount: number,
  jerseyNumber: number | null
): { mult: number; signal: string | null; isSpecial: boolean } {
  if (serial === 1) return { mult: 8, signal: "#1", isSpecial: true }
  if (jerseyNumber !== null && serial === jerseyNumber)
    return { mult: 2.5, signal: `Jersey #${serial}`, isSpecial: true }
  if (serial === circulationCount)
    return { mult: 1.3, signal: `Last #${serial}`, isSpecial: true }
  return { mult: 1, signal: null, isSpecial: false }
}

// ─── All Day GQL ─────────────────────────────────────────────────────────────

const SEARCH_LISTINGS_QUERY = `
  {
    searchMomentListings(
      input: {
        filters: {}
        searchInput: { pagination: { cursor: "", direction: RIGHT, limit: 100 } }
      }
    ) {
      data {
        searchSummary {
          pagination { rightCursor }
          data {
            ... on MomentListings {
              size
              data {
                ... on MomentListing {
                  id
                  flowRetailPrice { value }
                  setPlay {
                    setID
                    playID
                  }
                  serialNumber
                  circulationCount
                  setName
                  momentTier
                  momentTitle
                  playerName
                  isLocked
                  listingOrderID
                  storefrontListingID
                  sellerAddress
                }
              }
            }
          }
        }
      }
    }
  }
`

function parseListingPrice(listing: RawListing): number {
  if (listing.flowRetailPrice?.value) {
    return parseFloat(listing.flowRetailPrice.value) / 100_000_000
  }
  if (listing.marketplacePrice) return listing.marketplacePrice
  return 0
}

async function fetchADPage(
  cursor: string
): Promise<{ listings: RawListing[]; nextCursor: string | null }> {
  const MAX_ATTEMPTS = 2

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) {
        await new Promise((r) => setTimeout(r, 500))
      }
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 6000)
      const body = cursor
        ? JSON.stringify({
            query: SEARCH_LISTINGS_QUERY.replace(`cursor: ""`, `cursor: "${cursor}"`),
          })
        : JSON.stringify({ query: SEARCH_LISTINGS_QUERY })
      const res = await fetch(AD_GQL, {
        method: "POST",
        headers: GQL_HEADERS,
        body,
        signal: controller.signal,
      })
      clearTimeout(timeout)
      if (!res.ok) throw new Error(`GQL ${res.status}: ${await res.text().then((t) => t.slice(0, 200))}`)
      const json = await res.json()
      if (json.errors?.length) throw new Error(json.errors.map((e: { message: string }) => e.message).join("; "))
      const summary = json?.data?.searchMomentListings?.data?.searchSummary
      const nextCursor = summary?.pagination?.rightCursor ?? null
      const listings: RawListing[] = []
      const dataField = summary?.data
      if (Array.isArray(dataField)) {
        for (const block of dataField) {
          if (Array.isArray(block?.data)) listings.push(...block.data)
        }
      } else if (dataField?.data && Array.isArray(dataField.data)) {
        listings.push(...dataField.data)
      }
      console.log(`[allday-sniper] AD page cursor=${cursor || "start"} listings=${listings.length}`)
      return { listings, nextCursor }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (attempt >= MAX_ATTEMPTS) {
        console.error(`[allday-sniper] AD page FAILED: ${msg}`)
      }
    }
  }
  return { listings: [], nextCursor: null }
}

async function fetchAllDayPool(): Promise<{ listings: RawListing[]; adCount: number }> {
  const seen = new Set<string>()
  const all: RawListing[] = []
  function add(listings: RawListing[]) {
    for (const l of listings) {
      if (!seen.has(l.id)) { seen.add(l.id); all.push(l) }
    }
  }

  const p1 = await fetchADPage("")
  add(p1.listings)

  if (p1.listings.length > 0 && p1.nextCursor) {
    const p2 = await fetchADPage(p1.nextCursor)
    add(p2.listings)
    if (p2.nextCursor) {
      const p3 = await fetchADPage(p2.nextCursor)
      add(p3.listings)
    }
  }

  return { listings: all, adCount: all.length }
}

// ─── Flowty helpers ───────────────────────────────────────────────────────────

interface FlowtyOrder {
  listingResourceID: string
  storefrontAddress: string
  salePrice: number
  blockTimestamp: number
}

interface FlowtyNftItem {
  id: string
  orders?: FlowtyOrder[]
  card?: { title?: string; num?: number; max?: number }
  nftView?: { serial?: number; traits?: Array<{ name: string; value: string }> }
  valuations?: { blended?: { usdValue?: number }; livetoken?: { usdValue?: number } }
}

interface FlowtyListing {
  momentId: string
  price: number
  livetokenFmv: number | null
  playerName: string
  serial: number
  circulationCount: number
  setName: string
  teamName: string
  tier: string
  seriesNumber: number
}

const FLOWTY_TRAIT_MAP: Record<string, string[]> = {
  setName:      ["SetName", "setName", "Set Name"],
  teamName:     ["TeamAtMoment", "teamAtMoment", "Team", "team"],
  tier:         ["Tier", "tier", "MomentTier"],
  seriesNumber: ["SeriesNumber", "seriesNumber", "Series"],
  fullName:     ["FullName", "fullName", "PlayerName", "playerName"],
}

function getTraitMulti(
  traits: Array<{ name: string; value: string }> | undefined,
  keys: string[]
): string {
  if (!traits) return ""
  for (const key of keys) {
    const found = traits.find((t) => t.name === key)
    if (found?.value) return found.value
  }
  return ""
}

async function fetchFlowtyPage(from: number): Promise<FlowtyListing[]> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    const res = await fetch(FLOWTY_ENDPOINT, {
      method: "POST",
      headers: FLOWTY_HEADERS,
      body: JSON.stringify({
        address: null, addresses: [],
        collectionFilters: [{ collection: "0xe4cf4bdc1751c65d.AllDay", traits: [] }],
        from, includeAllListings: true, limit: 24, onlyUnlisted: false,
        orderFilters: [{ conditions: [], kind: "storefront", paymentTokens: [] }],
        sort: { direction: "desc", listingKind: "storefront", path: "blockTimestamp" },
      }),
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!res.ok) return []
    const json = await res.json()
    const rawItems: FlowtyNftItem[] = json?.nfts ?? json?.data ?? []

    const listings: FlowtyListing[] = []
    for (const item of rawItems) {
      const order = item.orders?.find((o) => (o.salePrice ?? 0) > 0) ?? item.orders?.[0]
      if (!order?.listingResourceID || order.salePrice <= 0) continue
      const traits = item.nftView?.traits ?? []
      const serial = item.card?.num ?? item.nftView?.serial ?? 0
      const circ = item.card?.max ?? 0
      const livetokenFmv = item.valuations?.blended?.usdValue ?? item.valuations?.livetoken?.usdValue ?? null

      listings.push({
        momentId: String(item.id),
        price: order.salePrice,
        livetokenFmv: (livetokenFmv && livetokenFmv > 0) ? livetokenFmv : null,
        playerName: item.card?.title ?? getTraitMulti(traits, FLOWTY_TRAIT_MAP.fullName) ?? "",
        serial,
        circulationCount: circ,
        setName: getTraitMulti(traits, FLOWTY_TRAIT_MAP.setName),
        teamName: getTraitMulti(traits, FLOWTY_TRAIT_MAP.teamName),
        tier: (getTraitMulti(traits, FLOWTY_TRAIT_MAP.tier) || "COMMON").toUpperCase(),
        seriesNumber: parseInt(getTraitMulti(traits, FLOWTY_TRAIT_MAP.seriesNumber) || "0", 10),
      })
    }
    return listings
  } catch (err) {
    console.error(`[allday-sniper] Flowty from=${from} FAILED: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

async function fetchAllFlowtyListings(): Promise<FlowtyListing[]> {
  const pages = await Promise.all([
    fetchFlowtyPage(0), fetchFlowtyPage(24),
    fetchFlowtyPage(48), fetchFlowtyPage(72),
  ])
  return pages.flat()
}

// ─── Supabase FMV lookup ──────────────────────────────────────────────────────

async function fetchFmvBatch(
  supabase: SupabaseClient,
  integerKeys: string[]
): Promise<Map<string, FmvRow>> {
  if (!integerKeys.length) return new Map()

  const { data: editionRows } = await (supabase as any)
    .from("editions")
    .select("id, external_id")
    .in("external_id", integerKeys)

  if (!editionRows?.length) return new Map()

  const extToUuid = new Map<string, string>()
  const uuidToExt = new Map<string, string>()
  for (const row of editionRows as { id: string; external_id: string }[]) {
    extToUuid.set(row.external_id, row.id)
    uuidToExt.set(row.id, row.external_id)
  }

  const { data: fmvRows } = await (supabase as any)
    .from("fmv_snapshots")
    .select("edition_id, fmv_usd, floor_price_usd, confidence")
    .in("edition_id", Array.from(extToUuid.values()))
    .order("computed_at", { ascending: false })

  if (!fmvRows?.length) return new Map()

  const seen = new Set<string>()
  const map = new Map<string, FmvRow>()
  for (const row of fmvRows as {
    edition_id: string; fmv_usd: number;
    floor_price_usd: number | null; confidence: string
  }[]) {
    if (seen.has(row.edition_id)) continue
    seen.add(row.edition_id)
    const extKey = uuidToExt.get(row.edition_id)
    if (!extKey) continue
    map.set(extKey, {
      editionKey: extKey,
      fmv: row.fmv_usd,
      floorPriceUsd: row.floor_price_usd,
      confidence: (row.confidence ?? "low").toLowerCase(),
    })
  }

  return map
}

// ─── Jersey lookup ───────────────────────────────────────────────────────────

async function fetchJerseyNumbers(
  supabase: SupabaseClient,
  playerNames: string[]
): Promise<Map<string, number>> {
  if (!playerNames.length) return new Map()
  const { data } = await (supabase as any)
    .from("players")
    .select("name, jersey_number")
    .eq("collection", "nfl_all_day")
    .in("name", playerNames)
    .not("jersey_number", "is", null)
  const map = new Map<string, number>()
  for (const row of (data ?? []) as { name: string; jersey_number: number }[]) {
    map.set(row.name, row.jersey_number)
  }
  return map
}

// ─── Main route ──────────────────────────────────────────────────────────────

const querySchema = z.object({
  tier: z.string().optional(),
  team: z.string().optional(),
  maxPrice: z.coerce.number().optional(),
  sort: z.enum(["discount", "price", "fmv"]).default("discount"),
  limit: z.coerce.number().min(1).max(200).default(50),
})

export async function GET(req: Request) {
  const startTime = Date.now()

  try {
    const url = new URL(req.url)
    const params = querySchema.safeParse(Object.fromEntries(url.searchParams))
    const filters = params.success ? params.data : { sort: "discount" as const, limit: 50 }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
    )

    // Fetch listings from All Day GQL + Flowty in parallel
    const [adPool, flowtyListings] = await Promise.all([
      getOrSetCache("allday-sniper-adpool", 60_000, fetchAllDayPool),
      getOrSetCache("allday-sniper-flowty", 60_000, fetchAllFlowtyListings),
    ])

    // Collect unique edition keys for FMV lookup
    const allEditionKeys = new Set<string>()
    for (const l of adPool.listings) {
      allEditionKeys.add(`${l.setPlay.setID}:${l.setPlay.playID}`)
    }

    const fmvMap = await fetchFmvBatch(supabase, [...allEditionKeys])

    // Collect player names for jersey lookup
    const playerNames = new Set<string>()
    for (const l of adPool.listings) {
      if (l.playerName) playerNames.add(l.playerName)
    }
    for (const l of flowtyListings) {
      if (l.playerName) playerNames.add(l.playerName)
    }
    const jerseyMap = await fetchJerseyNumbers(supabase, [...playerNames])

    // Build deals from All Day GQL listings
    const deals: SniperDeal[] = []
    const seenFlowIds = new Set<string>()

    for (const listing of adPool.listings) {
      const editionKey = `${listing.setPlay.setID}:${listing.setPlay.playID}`
      const askPrice = parseListingPrice(listing)
      if (askPrice <= 0) continue

      const fmvData = fmvMap.get(editionKey)
      const baseFmv = fmvData?.fmv ?? askPrice
      if (baseFmv <= 0) continue

      const jerseyNumber = jerseyMap.get(listing.playerName ?? "") ?? null
      const sm = serialMultiplier(listing.serialNumber, listing.circulationCount, jerseyNumber)
      const adjustedFmv = baseFmv * sm.mult

      const discount = adjustedFmv > 0 ? (adjustedFmv - askPrice) / adjustedFmv : 0
      const tier = (listing.momentTier || "COMMON").toUpperCase()
      const teamAbbrev = NFL_TEAMS[listing.playerName ?? ""] ?? ""
      const seriesName = SERIES_NAMES[listing.setSeriesNumber ?? 0] ?? `S${listing.setSeriesNumber ?? "?"}`

      seenFlowIds.add(listing.id)

      deals.push({
        flowId: listing.id,
        momentId: listing.id,
        editionKey,
        playerName: listing.playerName ?? listing.momentTitle ?? "Unknown",
        teamName: teamAbbrev,
        setName: listing.setName ?? "Unknown Set",
        seriesName,
        tier,
        serial: listing.serialNumber,
        circulationCount: listing.circulationCount,
        askPrice,
        baseFmv,
        adjustedFmv,
        discount,
        confidence: fmvData?.confidence ?? "none",
        serialMult: sm.mult,
        isSpecialSerial: sm.isSpecial,
        isJersey: sm.signal?.startsWith("Jersey") ?? false,
        serialSignal: sm.signal,
        thumbnailUrl: `https://assets.nflallday.com/media/${listing.id}/image?width=180`,
        isLocked: !!listing.isLocked,
        buyUrl: `https://nflallday.com/listing/moment/${listing.id}`,
        source: "nfl_all_day",
      })
    }

    // Merge Flowty listings
    for (const fl of flowtyListings) {
      if (seenFlowIds.has(fl.momentId)) continue
      const livetokenFmv = fl.livetokenFmv
      const baseFmv = livetokenFmv ?? fl.price
      if (baseFmv <= 0) continue

      const jerseyNumber = jerseyMap.get(fl.playerName) ?? null
      const sm = serialMultiplier(fl.serial, fl.circulationCount, jerseyNumber)
      const adjustedFmv = baseFmv * sm.mult
      const discount = adjustedFmv > 0 ? (adjustedFmv - fl.price) / adjustedFmv : 0
      const seriesName = SERIES_NAMES[fl.seriesNumber] ?? `S${fl.seriesNumber || "?"}`

      deals.push({
        flowId: fl.momentId,
        momentId: fl.momentId,
        editionKey: "",
        playerName: fl.playerName || "Unknown",
        teamName: NFL_TEAMS[fl.teamName] ?? fl.teamName ?? "",
        setName: fl.setName || "Unknown Set",
        seriesName,
        tier: fl.tier || "COMMON",
        serial: fl.serial,
        circulationCount: fl.circulationCount,
        askPrice: fl.price,
        baseFmv,
        adjustedFmv,
        discount,
        confidence: livetokenFmv ? "livetoken" : "none",
        serialMult: sm.mult,
        isSpecialSerial: sm.isSpecial,
        isJersey: sm.signal?.startsWith("Jersey") ?? false,
        serialSignal: sm.signal,
        thumbnailUrl: `https://assets.nflallday.com/media/${fl.momentId}/image?width=180`,
        isLocked: false,
        buyUrl: `https://www.flowty.io/asset/${fl.momentId}`,
        source: "flowty",
      })
    }

    // Apply filters
    let filtered = deals

    if (filters.tier) {
      const tierFilter = filters.tier.toUpperCase()
      filtered = filtered.filter(d => d.tier === tierFilter)
    }
    if (filters.team) {
      const teamFilter = filters.team.toUpperCase()
      filtered = filtered.filter(d => d.teamName.toUpperCase().includes(teamFilter))
    }
    if (filters.maxPrice) {
      filtered = filtered.filter(d => d.askPrice <= filters.maxPrice!)
    }

    // Sort
    if (filters.sort === "price") {
      filtered.sort((a, b) => a.askPrice - b.askPrice)
    } else if (filters.sort === "fmv") {
      filtered.sort((a, b) => b.baseFmv - a.baseFmv)
    } else {
      filtered.sort((a, b) => b.discount - a.discount)
    }

    const result = filtered.slice(0, filters.limit)
    const duration = Date.now() - startTime

    return NextResponse.json({
      deals: result,
      meta: {
        allDayListings: adPool.adCount,
        flowtyListings: flowtyListings.length,
        totalDeals: filtered.length,
        returned: result.length,
        durationMs: duration,
      },
    })
  } catch (err) {
    console.error("[allday-sniper] Fatal:", err)
    return NextResponse.json(
      { deals: [], error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    )
  }
}
