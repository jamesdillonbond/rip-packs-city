import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── AllDay Ingest via Flowty API ─────────────────────────────────────────────
//
// The AllDay GQL (searchMarketplaceTransactions) never returned data reliably.
// This rewrite fetches AllDay listings from Flowty's collection endpoint —
// the same approach that works for Top Shot (scripts/ts-ingest.js).
//
// Flowty endpoint: POST https://api2.flowty.io/collection/0xe4cf4bdc1751c65d/AllDay
// NFT traits contain editionID, setID, playID, playerName, jerseyNumber, etc.
// We parse these traits into editions, players, sets, and sales tables.
// ─────────────────────────────────────────────────────────────────────────────

const FLOWTY_ENDPOINT = "https://api2.flowty.io/collection/0xe4cf4bdc1751c65d/AllDay"

const FLOWTY_HEADERS = {
  "Content-Type": "application/json",
  "Origin": "https://www.flowty.io",
  "Referer": "https://www.flowty.io/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36",
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function formatTier(tier: string | null | undefined): string {
  if (!tier) return "COMMON"
  const t = tier.toUpperCase()
  if (t.includes("ULTIMATE")) return "ULTIMATE"
  if (t.includes("LEGENDARY")) return "LEGENDARY"
  if (t.includes("RARE")) return "RARE"
  if (t.includes("PREMIUM")) return "RARE"
  return "COMMON"
}

// Multi-key trait lookup — Flowty trait names vary between collections
const TRAIT_MAP: Record<string, string[]> = {
  playerName: ["PlayerName", "playerName", "Player Name", "FullName", "fullName"],
  firstName: ["FirstName", "firstName", "First Name"],
  lastName: ["LastName", "lastName", "Last Name"],
  jerseyNumber: ["JerseyNumber", "jerseyNumber", "Jersey Number", "jersey_number"],
  team: ["TeamAtMoment", "teamAtMoment", "Team", "team", "TeamName", "teamName"],
  tier: ["Tier", "tier", "MomentTier", "momentTier"],
  setName: ["SetName", "setName", "Set Name", "set_name"],
  seriesNumber: ["SeriesNumber", "seriesNumber", "Series Number", "series_number", "Series"],
  playCategory: ["PlayType", "playType", "PlayCategory", "playCategory", "Play Type"],
  gameDate: ["DateOfMoment", "dateOfMoment", "GameDate", "gameDate", "Date"],
  setID: ["SetID", "setID", "Set ID", "set_id"],
  playID: ["PlayID", "playID", "Play ID", "play_id"],
  editionID: ["EditionID", "editionID", "Edition ID", "edition_id"],
  playerID: ["PlayerID", "playerID", "Player ID", "player_id"],
  position: ["Position", "position"],
  circulationCount: ["CirculationCount", "circulationCount", "MaxMintSize", "maxMintSize"],
  retired: ["Retired", "retired", "FlowRetired", "flowRetired"],
  locked: ["Locked", "locked", "IsLocked", "isLocked"],
}

type TraitArray = Array<{ name: string; value: string }>

function getTraitMulti(
  traits: TraitArray | undefined,
  keys: string[]
): string | null {
  if (!traits) return null
  for (const key of keys) {
    const t = traits.find((tr) => tr.name === key)
    if (t?.value) return t.value
  }
  return null
}

// ── Flowty fetch ─────────────────────────────────────────────────────────────

interface FlowtyOrder {
  listingResourceID?: string
  storefrontAddress?: string
  flowtyStorefrontAddress?: string
  salePrice: number
  blockTimestamp?: number
}

interface FlowtyNftItem {
  id: string
  orders?: FlowtyOrder[]
  card?: { title?: string; num?: number; max?: number }
  nftView?: { serial?: number; traits?: TraitArray }
}

async function fetchFlowtyPage(from: number): Promise<FlowtyNftItem[]> {
  const res = await fetch(FLOWTY_ENDPOINT, {
    method: "POST",
    headers: FLOWTY_HEADERS,
    body: JSON.stringify({
      address: null,
      addresses: [],
      collectionFilters: [
        { collection: "0xe4cf4bdc1751c65d.AllDay", traits: [] },
      ],
      from,
      includeAllListings: true,
      limit: 24,
      onlyUnlisted: false,
      orderFilters: [
        { conditions: [], kind: "storefront", paymentTokens: [] },
      ],
      sort: {
        direction: "desc",
        listingKind: "storefront",
        path: "blockTimestamp",
      },
    }),
    signal: AbortSignal.timeout(12000),
  })
  if (!res.ok) {
    throw new Error(
      `Flowty HTTP ${res.status} from=${from}: ${(await res.text()).slice(0, 200)}`
    )
  }
  const json = await res.json()
  return (json?.nfts ?? json?.data ?? []) as FlowtyNftItem[]
}

// ── Supabase upserts ─────────────────────────────────────────────────────────

async function upsertPlayer(
  collectionId: string,
  traits: TraitArray
): Promise<string | null> {
  const playerIdRaw = getTraitMulti(traits, TRAIT_MAP.playerID)
  if (!playerIdRaw) return null

  const playerName =
    getTraitMulti(traits, TRAIT_MAP.playerName) ?? "Unknown Player"
  const firstName = getTraitMulti(traits, TRAIT_MAP.firstName)
  const lastName = getTraitMulti(traits, TRAIT_MAP.lastName)
  const team = getTraitMulti(traits, TRAIT_MAP.team)
  const jerseyNumber = toNum(getTraitMulti(traits, TRAIT_MAP.jerseyNumber))

  const { data, error } = await supabaseAdmin
    .from("players")
    .upsert(
      {
        external_id: String(playerIdRaw),
        collection_id: collectionId,
        name: playerName,
        first_name: firstName ?? null,
        last_name: lastName ?? null,
        team: team ?? null,
        jersey_number: jerseyNumber,
      },
      { onConflict: "external_id", ignoreDuplicates: false }
    )
    .select("id")
    .single()

  if (error) {
    console.error("[ALLDAY-INGEST] upsertPlayer error:", error.message)
    return null
  }
  return data?.id ?? null
}

async function upsertSet(
  collectionId: string,
  traits: TraitArray,
  tier: string
): Promise<string | null> {
  const setIdRaw = getTraitMulti(traits, TRAIT_MAP.setID)
  if (!setIdRaw) return null

  const setName = getTraitMulti(traits, TRAIT_MAP.setName) ?? "Unknown Set"
  const series = toNum(getTraitMulti(traits, TRAIT_MAP.seriesNumber))

  const { data, error } = await supabaseAdmin
    .from("sets")
    .upsert(
      {
        external_id: setIdRaw,
        collection_id: collectionId,
        name: setName,
        series,
        tier: tier as "COMMON" | "RARE" | "LEGENDARY" | "ULTIMATE" | "FANDOM",
      },
      { onConflict: "external_id", ignoreDuplicates: false }
    )
    .select("id")
    .single()

  if (error) {
    console.error("[ALLDAY-INGEST] upsertSet error:", error.message)
    return null
  }
  return data?.id ?? null
}

async function upsertEdition(
  collectionId: string,
  playerId: string | null,
  setDbId: string | null,
  traits: TraitArray,
  editionKey: string,
  tier: string
): Promise<string | null> {
  const circulationCount = toNum(
    getTraitMulti(traits, TRAIT_MAP.circulationCount)
  )
  const isRetired =
    getTraitMulti(traits, TRAIT_MAP.retired) === "true"
  const playerName =
    getTraitMulti(traits, TRAIT_MAP.playerName) ?? "Unknown"
  const setName = getTraitMulti(traits, TRAIT_MAP.setName) ?? "Unknown Set"
  const series = toNum(getTraitMulti(traits, TRAIT_MAP.seriesNumber))
  const playCategory = getTraitMulti(traits, TRAIT_MAP.playCategory)
  const gameDate = getTraitMulti(traits, TRAIT_MAP.gameDate)

  const { data, error } = await supabaseAdmin
    .from("editions")
    .upsert(
      {
        external_id: editionKey,
        collection_id: collectionId,
        player_id: playerId,
        set_id: setDbId,
        name: `${playerName} — ${setName}`,
        tier: tier as "COMMON" | "RARE" | "LEGENDARY" | "ULTIMATE" | "FANDOM",
        series,
        edition_kind: isRetired ? "LE" : "CC",
        circulation_count: circulationCount,
        play_category: playCategory ?? null,
        game_date: gameDate ? gameDate.split("T")[0] : null,
      },
      { onConflict: "external_id", ignoreDuplicates: false }
    )
    .select("id")
    .single()

  if (error) {
    console.error("[ALLDAY-INGEST] upsertEdition error:", error.message)
    return null
  }
  return data?.id ?? null
}

async function insertSale(
  collectionId: string,
  editionId: string,
  nftId: string,
  serial: number,
  price: number,
  listingId: string,
  blockTimestamp: number | undefined
): Promise<boolean> {
  // Use listing ID as a pseudo transaction hash for dedup
  const txHash = `flowty-allday-${listingId}`
  const soldAt = blockTimestamp
    ? new Date(blockTimestamp * 1000).toISOString()
    : new Date().toISOString()

  // Write moment row
  if (nftId && serial > 0) {
    const { error: momentError } = await supabaseAdmin
      .from("moments")
      .upsert(
        {
          nft_id: nftId,
          edition_id: editionId,
          collection_id: collectionId,
          serial_number: serial,
        },
        { onConflict: "nft_id", ignoreDuplicates: true }
      )
    if (momentError && momentError.code !== "23505") {
      console.error("[ALLDAY-INGEST] upsertMoment error:", momentError.message)
    }
  }

  // Write sale row
  const { error } = await supabaseAdmin.from("sales").insert({
    edition_id: editionId,
    collection_id: collectionId,
    serial_number: serial || 0,
    price_usd: price,
    currency: "USD",
    marketplace: "nfl_all_day",
    transaction_hash: txHash,
    sold_at: soldAt,
    nft_id: nftId || null,
  })

  if (error) {
    if (error.message.includes("duplicate") || error.code === "23505") {
      return false // duplicate, not an error
    }
    console.error("[ALLDAY-INGEST] insertSale error:", error.message)
    return false
  }
  return true
}

async function upsertFmvSnapshot(
  collectionId: string,
  editionId: string,
  recentSales: number[]
): Promise<void> {
  if (!recentSales.length) return

  const sorted = [...recentSales].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid]

  const floor = sorted[0]
  const confidence =
    recentSales.length >= 5
      ? "HIGH"
      : recentSales.length >= 2
        ? "MEDIUM"
        : "LOW"

  const { error } = await supabaseAdmin
    .from("fmv_snapshots")
    .upsert(
      {
        edition_id: editionId,
        collection_id: collectionId,
        fmv_usd: Number(median.toFixed(2)),
        floor_price_usd: Number(floor.toFixed(2)),
        confidence: confidence as "LOW" | "MEDIUM" | "HIGH",
        sales_count_7d: recentSales.length,
        algo_version: "1.1.0",
      },
      { onConflict: "edition_id", ignoreDuplicates: false }
    )

  if (error) {
    console.error("[ALLDAY-INGEST] FMV snapshot error:", error.message)
  }
}

// ── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const startTime = Date.now()

  // Auth — Bearer token
  const authHeader = req.headers.get("authorization")
  const expectedToken = process.env.INGEST_SECRET_TOKEN
  if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const pageCount = Math.min(Number(body.pages ?? 5), 10)

    console.log(`[ALLDAY-INGEST] Starting — pages=${pageCount} via Flowty API`)

    // Get NFL All Day collection ID
    const { data: collections } = await supabaseAdmin
      .from("collections")
      .select("id")
      .eq("slug", "nfl_all_day")
      .single()

    if (!collections?.id) {
      return NextResponse.json(
        { error: "NFL All Day collection not found in DB" },
        { status: 500 }
      )
    }

    const collectionId = collections.id

    // Fetch listings from Flowty in parallel (same pattern as ts-ingest.js)
    const offsets = Array.from({ length: pageCount }, (_, i) => i * 24)
    const pages = await Promise.allSettled(offsets.map((o) => fetchFlowtyPage(o)))

    const allItems: FlowtyNftItem[] = []
    for (const [i, result] of pages.entries()) {
      if (result.status === "fulfilled") {
        console.log(`[ALLDAY-INGEST] Page from=${offsets[i]}: ${result.value.length} items`)
        allItems.push(...result.value)
      } else {
        console.error(
          `[ALLDAY-INGEST] Page from=${offsets[i]} failed: ${result.reason?.message}`
        )
      }
    }

    // Log first item structure for debugging
    if (allItems.length > 0) {
      const first = allItems[0]
      const traits = first.nftView?.traits ?? []
      console.log(
        "[ALLDAY-INGEST] Trait keys:",
        traits.map((t) => t.name).join(", ")
      )
      console.log(
        "[ALLDAY-INGEST] Sample — SetID:",
        getTraitMulti(traits, TRAIT_MAP.setID),
        "PlayID:",
        getTraitMulti(traits, TRAIT_MAP.playID),
        "Player:",
        getTraitMulti(traits, TRAIT_MAP.playerName)
      )
    }

    console.log(`[ALLDAY-INGEST] Total fetched: ${allItems.length}`)

    let salesIngested = 0
    let momentsWritten = 0
    let editionsUpdated = 0
    let duplicates = 0
    let errors = 0

    // Track sales prices per edition for FMV snapshot computation
    const editionSalesMap = new Map<string, number[]>()

    for (const item of allItems) {
      try {
        const order = item.orders?.find((o) => (o.salePrice ?? 0) > 0)
        if (!order) continue

        const price = order.salePrice
        if (!price || price <= 0) continue

        const traits = item.nftView?.traits ?? []
        const serial = item.card?.num ?? item.nftView?.serial ?? 0

        // Build edition key from setID:playID traits
        const rawSetId = getTraitMulti(traits, TRAIT_MAP.setID)
        const rawPlayId = getTraitMulti(traits, TRAIT_MAP.playID)
        if (!rawSetId || !rawPlayId) continue
        const editionKey = `${rawSetId}:${rawPlayId}`

        const tier = formatTier(getTraitMulti(traits, TRAIT_MAP.tier))

        // Upsert player, set, edition
        const playerId = await upsertPlayer(collectionId, traits)
        const setDbId = await upsertSet(collectionId, traits, tier)
        const editionId = await upsertEdition(
          collectionId,
          playerId,
          setDbId,
          traits,
          editionKey,
          tier
        )
        if (!editionId) continue

        editionsUpdated++

        const nftId = String(item.id)
        const listingId =
          order.listingResourceID ?? String(item.id)

        const inserted = await insertSale(
          collectionId,
          editionId,
          nftId,
          serial,
          price,
          listingId,
          order.blockTimestamp
        )

        if (serial > 0) momentsWritten++

        if (inserted) {
          salesIngested++
        } else {
          if (serial > 0) momentsWritten--
          duplicates++
        }

        // Accumulate prices for FMV
        const arr = editionSalesMap.get(editionId) ?? []
        arr.push(price)
        editionSalesMap.set(editionId, arr)
      } catch (err) {
        console.error("[ALLDAY-INGEST] Item error:", err)
        errors++
      }
    }

    // Compute and store FMV snapshots
    let fmvUpdated = 0
    for (const [editionId, sales] of editionSalesMap.entries()) {
      try {
        await upsertFmvSnapshot(collectionId, editionId, sales)
        fmvUpdated++
      } catch (err) {
        console.error("[ALLDAY-INGEST] FMV snapshot error:", err)
      }
    }

    const duration = Date.now() - startTime

    console.log(
      `[ALLDAY-INGEST] Done — sales=${salesIngested} dupes=${duplicates} moments=${momentsWritten} editions=${editionsUpdated} fmv=${fmvUpdated} errors=${errors} duration=${duration}ms`
    )

    return NextResponse.json({
      ok: true,
      collection: "nfl_all_day",
      salesIngested,
      momentsWritten,
      duplicates,
      editionsUpdated,
      fmvUpdated,
      errors,
      durationMs: duration,
    })
  } catch (e) {
    console.error("[ALLDAY-INGEST] Fatal error:", e)
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "Ingestion failed",
      },
      { status: 500 }
    )
  }
}

// Allow GET for browser / debug testing
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? ""
  const expectedToken = process.env.INGEST_SECRET_TOKEN
  if (expectedToken && token !== expectedToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const debug = req.nextUrl.searchParams.get("debug") === "1"

  // Debug mode: return raw Flowty response for inspection
  if (debug) {
    try {
      const items = await fetchFlowtyPage(0)
      const sample = items.length > 0 ? items[0] : null
      return NextResponse.json({
        mode: "debug",
        itemCount: items.length,
        sampleTraits: sample?.nftView?.traits ?? [],
        sampleCard: sample?.card ?? null,
        sampleOrders: sample?.orders?.slice(0, 1) ?? [],
      })
    } catch (e) {
      return NextResponse.json(
        {
          mode: "debug",
          error: e instanceof Error ? e.message : String(e),
        },
        { status: 500 }
      )
    }
  }

  // Normal flow — delegate to POST handler
  return POST(req)
}
