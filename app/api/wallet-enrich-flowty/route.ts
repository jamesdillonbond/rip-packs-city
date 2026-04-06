import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

/**
 * POST /api/wallet-enrich-flowty
 *
 * Enriches a collector's wallet with live FMV and Low Ask data from Flowty API
 * (primary source) with badge_editions fallback. Writes fmv_snapshots with
 * algo_version 'flowty-live'.
 *
 * Body: { wallet: string }  — accepts Flow address or Top Shot username
 */

export const maxDuration = 60

const TOPSHOT_GQL = "https://public-api.nbatopshot.com/graphql"
const GQL_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "User-Agent": "sports-collectible-tool/0.1",
}

const FLOWTY_ENDPOINT = "https://api2.flowty.io/collection/0x0b2a3299cc857e29/TopShot"
const FLOWTY_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "Origin": "https://www.flowty.io",
  "Referer": "https://www.flowty.io/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36",
}

// ── Resolve username → Flow address ─────────────────────────────────────────

async function resolveToFlowAddress(input: string): Promise<string | null> {
  const trimmed = input.trim()
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return trimmed
  try {
    const res = await fetch(TOPSHOT_GQL, {
      method: "POST",
      headers: GQL_HEADERS,
      body: JSON.stringify({
        query: `query($username: String!) {
          getUserProfileByUsername(input: { username: $username }) {
            publicInfo { flowAddress username }
          }
        }`,
        variables: { username: trimmed.replace(/^@+/, "") },
      }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const json = await res.json()
    const addr = json?.data?.getUserProfileByUsername?.publicInfo?.flowAddress
    if (!addr) return null
    return addr.startsWith("0x") ? addr : "0x" + addr
  } catch {
    return null
  }
}

// ── Flowty trait extraction (copied from sniper-feed/route.ts) ─────────────

const FLOWTY_TRAIT_MAP: Record<string, string[]> = {
  setName:      ["SetName", "setName", "Set Name", "set_name"],
  teamName:     ["TeamAtMoment", "teamAtMoment", "Team", "team"],
  tier:         ["Tier", "tier", "MomentTier", "momentTier"],
  seriesNumber: ["SeriesNumber", "seriesNumber", "Series Number", "series_number", "Series"],
  subedition:   ["Subedition", "subedition", "SubeditionID", "subeditionId"],
  locked:       ["Locked", "locked", "IsLocked", "isLocked"],
  fullName:     ["FullName", "fullName", "Full Name", "PlayerName", "playerName"],
};

function flattenTraits(raw: unknown): Array<{ name: string; value: string }> {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  const inner = (raw as Record<string, unknown>).traits ?? raw
  if (Array.isArray(inner)) return inner
  return Object.values(inner as Record<string, unknown>)
    .filter((v): v is { name: string; value: string } =>
      typeof v === "object" && v !== null && "name" in v)
}

function getTraitMulti(
  traits: Array<{ name: string; value: string }> | undefined,
  keys: string[]
): string {
  if (!traits) return "";
  for (const key of keys) {
    const found = traits.find((t) => t.name === key);
    if (found?.value) return found.value;
  }
  return "";
}

// ── Flowty data types ──────────────────────────────────────────────────────

type FlowtyEditionData = { editionKey: string; flowtyAsk: number; livetokenFmv: number | null; playerName: string; setName: string; series: number | null; circulationCount: number | null; tier: string | null }

type FlowtyPageDebug = {
  from: number
  sortPath: string
  httpStatus: number | null
  error: string | null
  rawSample: string | null
  responseKeys: string | null
  itemCount: number
  parsedCount: number
}

// ── Edition key extraction from Flowty listing ──────────────────────────────

function extractEditionKey(item: any, traits: Array<{ name: string; value: string }>): string | null {
  // Try traits first: look for SetID and PlayID
  const setIdTrait = traits.find(function (t) { return t.name === "SetID" || t.name === "setID" || t.name === "setId" })
  const playIdTrait = traits.find(function (t) { return t.name === "PlayID" || t.name === "playID" || t.name === "playId" })
  if (setIdTrait?.value && playIdTrait?.value) {
    return setIdTrait.value + ":" + playIdTrait.value
  }

  // Try nft.card.traits array
  const cardTraits = item.card?.traits
  if (Array.isArray(cardTraits)) {
    const cSetId = cardTraits.find(function (t: any) { return t.name === "SetID" || t.name === "setID" })
    const cPlayId = cardTraits.find(function (t: any) { return t.name === "PlayID" || t.name === "playID" })
    if (cSetId?.value && cPlayId?.value) {
      return cSetId.value + ":" + cPlayId.value
    }
  }

  // Try nft.nftId path (format may contain setID/playID)
  const nftId = item.nftId ?? item.nft?.nftId
  if (typeof nftId === "string" && nftId.includes(":")) {
    const parts = nftId.split(":")
    if (parts.length >= 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
      return parts[0] + ":" + parts[1]
    }
  }

  return null
}

// ── Flowty series / circulation extraction ──────────────────────────────────

function parseSeriesName(seriesName: string): number | null {
  if (!seriesName) return null
  const lower = seriesName.toLowerCase().trim()
  if (lower === "beta") return 0
  const match = lower.match(/series\s*(\d+)/)
  if (match) return Number(match[1])
  const numMatch = lower.match(/^(\d+)$/)
  if (numMatch) return Number(numMatch[1])
  return null
}

function parseCirculationFromDetails(item: any): number | null {
  // card.additionalDetails[1] has format like "Common #126 / 1149"
  const details = item.card?.additionalDetails
  if (!Array.isArray(details) || details.length < 2) return null
  const detail = details[1]
  if (typeof detail !== "string") return null
  const match = detail.match(/\/\s*(\d+)/)
  if (match) return Number(match[1])
  return null
}

// ── Multi-level match keys ──────────────────────────────────────────────────

function makeMatchKeyWithCirculation(playerName: string, setName: string, series: string, circulation: number): string {
  return (playerName.trim() + " — " + setName.trim() + " — " + series.trim() + " — " + String(circulation)).toLowerCase()
}

function makeMatchKeyWithTier(playerName: string, setName: string, series: string, circulation: number, tier: string): string {
  return (playerName.trim() + " — " + setName.trim() + " — " + series.trim() + " — " + String(circulation) + " — " + tier.trim()).toLowerCase()
}

// ── Flowty matching key: lowercase "playerName — setName — series" ───────────

function makeMatchKey(playerName: string, setName: string, series?: string): string {
  const base = (playerName.trim() + " — " + setName.trim()).toLowerCase()
  if (series && series !== "0" && series !== "") {
    return base + " — " + series.trim().toLowerCase()
  }
  return base
}

function makeBaseKey(playerName: string, setName: string): string {
  return (playerName.trim() + " — " + setName.trim()).toLowerCase()
}

type FlowtyPageSort = { path: string; direction: string }

async function fetchFlowtyPage(from: number, sort: FlowtyPageSort): Promise<{ items: Array<{ editionKey: string | null; matchKey: string; baseKey: string; fullMatchKey: string; tierMatchKey: string; data: FlowtyEditionData }>; debug: FlowtyPageDebug }> {
  const items: Array<{ editionKey: string | null; matchKey: string; baseKey: string; fullMatchKey: string; tierMatchKey: string; data: FlowtyEditionData }> = []
  const debug: FlowtyPageDebug = { from, sortPath: sort.path, httpStatus: null, error: null, rawSample: null, responseKeys: null, itemCount: 0, parsedCount: 0 }

  const requestBody = {
    address: null, addresses: [],
    collectionFilters: [{ collection: "0x0b2a3299cc857e29.TopShot", traits: [] }],
    from, includeAllListings: true, limit: 24, onlyUnlisted: false,
    orderFilters: [{ conditions: [], kind: "storefront", paymentTokens: [] }],
    sort: { direction: sort.direction, listingKind: "storefront", path: sort.path },
  }

  const isFirstPage = from === 0 && sort.path === "blockTimestamp"
  if (isFirstPage) {
    console.log("[wallet-enrich] Flowty URL: " + FLOWTY_ENDPOINT)
    console.log("[wallet-enrich] Flowty body: " + JSON.stringify(requestBody))
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(function () { controller.abort() }, 10000)
    const res = await fetch(FLOWTY_ENDPOINT, {
      method: "POST",
      headers: FLOWTY_HEADERS,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    })
    clearTimeout(timeout)

    debug.httpStatus = res.status

    const rawText = await res.text()
    debug.rawSample = rawText.substring(0, 500)

    if (!res.ok) {
      debug.error = "HTTP " + res.status + " " + res.statusText
      console.log("[wallet-enrich] Flowty HTTP " + res.status + " sort=" + sort.path + " from=" + from + " body=" + rawText.substring(0, 200))
      return { items, debug }
    }

    let json: any
    try {
      json = JSON.parse(rawText)
    } catch (parseErr) {
      debug.error = "JSON parse failed: " + (parseErr instanceof Error ? parseErr.message : String(parseErr))
      return { items, debug }
    }

    const topKeys = Object.keys(json ?? {})
    debug.responseKeys = topKeys.join(", ")

    const rawItems: any[] = json?.nfts ?? json?.data ?? []
    debug.itemCount = rawItems.length

    if (isFirstPage && rawItems.length > 0) {
      // Log first listing structure for debugging edition key extraction
      console.log("[wallet-enrich] Flowty first listing (500 chars): " + JSON.stringify(rawItems[0]).substring(0, 500))
      const firstTraits = flattenTraits(rawItems[0].nftView?.traits)
      console.log("[wallet-enrich] Flowty trait names: " + firstTraits.map(function (t: { name: string }) { return t.name }).join(", "))
      console.log("[wallet-enrich] Flowty first item keys: " + Object.keys(rawItems[0]).join(", "))
    }

    for (const item of rawItems) {
      const order = item.orders?.find(function (o: any) { return (o.salePrice ?? 0) > 0 }) ?? item.orders?.[0]
      if (!order || order.salePrice <= 0) continue
      const traits = flattenTraits(item.nftView?.traits)
      const livetokenFmv = item.valuations?.blended?.usdValue ?? item.valuations?.livetoken?.usdValue ?? null

      const editionKey = extractEditionKey(item, traits)

      // Extract player name from card.title, set name + series from traits
      const playerName = item.card?.title ?? getTraitMulti(traits, FLOWTY_TRAIT_MAP.fullName) ?? ""
      const setName = getTraitMulti(traits, FLOWTY_TRAIT_MAP.setName)
      const seriesNumber = getTraitMulti(traits, FLOWTY_TRAIT_MAP.seriesNumber)

      // Extract series and tier from headerTraits
      const headerTraits = item.card?.headerTraits
      let parsedSeries: number | null = null
      let parsedTier: string | null = null
      if (Array.isArray(headerTraits)) {
        const seriesTrait = headerTraits.find(function (ht: any) { return ht.name === "SeriesName" || ht.name === "Series" })
        if (seriesTrait?.value) parsedSeries = parseSeriesName(seriesTrait.value)
        const tierTrait = headerTraits.find(function (ht: any) { return ht.name === "Tier" || ht.name === "tier" })
        if (tierTrait?.value) parsedTier = tierTrait.value.toUpperCase()
      }
      if (parsedSeries == null && seriesNumber) parsedSeries = parseSeriesName(seriesNumber)
      // Fallback tier from nftView traits
      if (!parsedTier) {
        const traitTier = getTraitMulti(traits, FLOWTY_TRAIT_MAP.tier)
        if (traitTier) parsedTier = traitTier.toUpperCase()
      }

      // Extract circulation from additionalDetails[1] e.g. "Common #126 / 1149" → 1149
      const circulationCount = parseCirculationFromDetails(item)

      if (!playerName && !editionKey) continue

      const matchKey = (playerName && setName) ? makeMatchKey(playerName, setName, seriesNumber) : ""
      const baseKey = (playerName && setName) ? makeBaseKey(playerName, setName) : ""
      const fullMatchKey = (playerName && setName && parsedSeries != null && circulationCount != null)
        ? makeMatchKeyWithCirculation(playerName, setName, String(parsedSeries), circulationCount)
        : ""
      const tierMatchKey = (playerName && setName && parsedSeries != null && circulationCount != null && parsedTier)
        ? makeMatchKeyWithTier(playerName, setName, String(parsedSeries), circulationCount, parsedTier)
        : ""

      items.push({
        editionKey,
        matchKey,
        baseKey,
        fullMatchKey,
        tierMatchKey,
        data: {
          editionKey: editionKey ?? "",
          flowtyAsk: order.salePrice,
          livetokenFmv: livetokenFmv && livetokenFmv > 0 ? livetokenFmv : null,
          playerName: playerName || "",
          setName: setName || "",
          series: parsedSeries,
          circulationCount,
          tier: parsedTier,
        },
      })
    }
    debug.parsedCount = items.length
    return { items, debug }
  } catch (err) {
    debug.error = "exception: " + (err instanceof Error ? err.message : String(err))
    console.log("[wallet-enrich] Flowty sort=" + sort.path + " from=" + from + " exception: " + (err instanceof Error ? err.message : String(err)))
    return { items, debug }
  }
}

type FlowtyDebugSummary = {
  totalItems: number
  uniqueEditions: number
  pagesFetched: number
  pageDebug: FlowtyPageDebug[]
  requestUrl: string
}

async function fetchAllFlowtyData(): Promise<{
  editionKeyMap: Map<string, FlowtyEditionData>
  tierMatchMap: Map<string, FlowtyEditionData>
  fullMatchMap: Map<string, FlowtyEditionData>
  nameMatchMap: Map<string, FlowtyEditionData>
  debugSummary: FlowtyDebugSummary
}> {
  // Map keyed by setID:playID edition key → lowest ask for that edition
  const editionKeyMap = new Map<string, FlowtyEditionData>()
  // Tightest fallback: name + series + circulation_count + tier
  const tierMatchMap = new Map<string, FlowtyEditionData>()
  // Best fallback: name + series + circulation_count (exact edition match)
  const fullMatchMap = new Map<string, FlowtyEditionData>()
  // Good fallback: name + series
  const nameMatchMap = new Map<string, FlowtyEditionData>()

  const PAGES_PER_PASS = 50
  const BATCH_SIZE = 5

  const sorts: FlowtyPageSort[] = [
    { path: "blockTimestamp", direction: "desc" },  // Pass 1: most recent
    { path: "salePrice", direction: "asc" },        // Pass 2: cheapest first
  ]

  let totalItems = 0
  let totalPagesFetched = 0
  const allPageDebug: FlowtyPageDebug[] = []

  for (const sort of sorts) {
    console.log("[wallet-enrich] Starting Flowty pass: sort=" + sort.path + " direction=" + sort.direction + " pages=" + PAGES_PER_PASS)

    // Build all offsets for this pass
    const offsets: number[] = []
    for (let p = 0; p < PAGES_PER_PASS; p++) {
      offsets.push(p * 24)
    }

    // Fetch in parallel batches of BATCH_SIZE
    for (let b = 0; b < offsets.length; b += BATCH_SIZE) {
      const batch = offsets.slice(b, b + BATCH_SIZE)
      const results = await Promise.all(batch.map(function (o) { return fetchFlowtyPage(o, sort) }))

      let batchEmpty = true
      for (const page of results) {
        allPageDebug.push(page.debug)
        totalPagesFetched++
        if (page.items.length > 0) batchEmpty = false
        totalItems += page.items.length

        for (const item of page.items) {
          // Primary: key by setID:playID edition key
          if (item.editionKey) {
            const existing = editionKeyMap.get(item.editionKey)
            if (!existing || item.data.flowtyAsk < existing.flowtyAsk) {
              editionKeyMap.set(item.editionKey, item.data)
            }
          }

          // Tightest fallback: name + series + circulation + tier
          if (item.tierMatchKey) {
            const existing = tierMatchMap.get(item.tierMatchKey)
            if (!existing || item.data.flowtyAsk < existing.flowtyAsk) {
              tierMatchMap.set(item.tierMatchKey, item.data)
            }
          }

          // Best fallback: name + series + circulation (exact edition)
          if (item.fullMatchKey) {
            const existing = fullMatchMap.get(item.fullMatchKey)
            if (!existing || item.data.flowtyAsk < existing.flowtyAsk) {
              fullMatchMap.set(item.fullMatchKey, item.data)
            }
          }

          // Good fallback: key by name (series-specific + base)
          if (item.matchKey) {
            const existing = nameMatchMap.get(item.matchKey)
            if (!existing || item.data.flowtyAsk < existing.flowtyAsk) {
              nameMatchMap.set(item.matchKey, item.data)
            }
          }
          if (item.baseKey && !nameMatchMap.has(item.baseKey)) {
            nameMatchMap.set(item.baseKey, item.data)
          } else if (item.baseKey) {
            const existingBase = nameMatchMap.get(item.baseKey)!
            if (item.data.flowtyAsk < existingBase.flowtyAsk) {
              nameMatchMap.set(item.baseKey, item.data)
            }
          }
        }
      }

      // Stop this pass early if a full batch returned zero items
      if (batchEmpty) {
        console.log("[wallet-enrich] sort=" + sort.path + " batch at offset " + batch[0] + " empty, stopping pass early")
        break
      }
    }

    console.log("[wallet-enrich] Pass sort=" + sort.path + " done: editionKeyMap=" + editionKeyMap.size + " tierMatchMap=" + tierMatchMap.size + " fullMatchMap=" + fullMatchMap.size + " nameMatchMap=" + nameMatchMap.size)
  }

  return {
    editionKeyMap,
    tierMatchMap,
    fullMatchMap,
    nameMatchMap,
    debugSummary: {
      totalItems,
      uniqueEditions: editionKeyMap.size,
      pagesFetched: totalPagesFetched,
      pageDebug: allPageDebug,
      requestUrl: FLOWTY_ENDPOINT,
    },
  }
}

// ── Main route handler ──────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const startTime = Date.now()

  let walletInput: string
  try {
    const body = await req.json()
    walletInput = (body.wallet as string)?.trim()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  if (!walletInput) {
    return NextResponse.json({ error: "wallet required" }, { status: 400 })
  }

  // Resolve username to Flow address
  const wallet = await resolveToFlowAddress(walletInput)
  if (!wallet) {
    return NextResponse.json({ error: "Could not resolve wallet: " + walletInput }, { status: 400 })
  }
  console.log("[wallet-enrich] input=" + walletInput + " resolved=" + wallet)

  // Step 1: Get unique edition_keys for this wallet via RPC (returns json_agg array)
  const { data: rpcData, error: cacheErr } = await (supabaseAdmin as any)
    .rpc("get_wallet_edition_keys", { p_wallet: wallet })

  console.log("[wallet-enrich] rpc raw type=" + typeof rpcData + " isArray=" + Array.isArray(rpcData) + " length=" + (rpcData?.length ?? "null"))

  // json_agg returns: the JSON array directly, OR a single-element wrapper array containing it
  let editionKeys: string[]
  if (Array.isArray(rpcData) && rpcData.length > 0 && Array.isArray(rpcData[0])) {
    // Single-element wrapper: data[0] is the JSON array
    editionKeys = rpcData[0]
  } else if (Array.isArray(rpcData) && rpcData.length > 0 && typeof rpcData[0] === "string") {
    // Direct JSON array of strings
    editionKeys = rpcData
  } else if (typeof rpcData === "string") {
    // Returned as raw JSON string
    editionKeys = JSON.parse(rpcData)
  } else if (Array.isArray(rpcData)) {
    // Fallback: might be [{edition_key: "..."}] row format
    editionKeys = rpcData.map(function (r: any) { return r.edition_key ?? r })
  } else {
    editionKeys = []
  }

  if (cacheErr || !editionKeys.length) {
    const diag = { ok: true, enriched: 0, reason: cacheErr ? "cache error: " + cacheErr.message : "no editions", wallet, input: walletInput, rpc_type: typeof rpcData, rpc_sample: JSON.stringify(rpcData)?.substring(0, 200) }
    await (supabaseAdmin as any).from("debug_logs").insert({ route: "wallet-enrich-flowty", payload: diag }).catch(function () {})
    return NextResponse.json(diag)
  }

  const uniqueKeys: string[] = editionKeys.filter(function (k: any) { return typeof k === "string" && k.length > 0 })
  const keySet = new Set<string>(uniqueKeys)
  console.log("[wallet-enrich] wallet=" + wallet + " unique_editions=" + uniqueKeys.length)

  // Step 2: Resolve editions to internal UUIDs + names + series + circulation_count + tier
  const editionUuidMap = new Map<string, { id: string; collectionId: string; name: string; series: string | null; circulationCount: number | null; tier: string | null }>()
  const CHUNK = 800
  for (let i = 0; i < uniqueKeys.length; i += CHUNK) {
    const chunk = uniqueKeys.slice(i, i + CHUNK)
    const { data: rows } = await (supabaseAdmin as any)
      .from("editions")
      .select("id, external_id, collection_id, name, series, circulation_count, tier")
      .in("external_id", chunk)
      .limit(10000)
    for (const r of (rows ?? [])) {
      if (r.id) {
        editionUuidMap.set(r.external_id, { id: r.id, collectionId: r.collection_id ?? null, name: r.name ?? "", series: r.series != null ? String(r.series) : null, circulationCount: r.circulation_count != null ? Number(r.circulation_count) : null, tier: r.tier ?? null })
      }
    }
  }
  console.log("[wallet-enrich] edition_uuid_resolved=" + editionUuidMap.size + "/" + uniqueKeys.length)

  // Step 2b: Create missing editions on the fly
  const TS_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
  const missingKeys = uniqueKeys.filter(function (k) { return !editionUuidMap.has(k) })
  let editionsCreated = 0
  const editionsCreateDebug: Record<string, unknown> = { missing_keys: 0, badge_meta_found: 0, wallet_cache_meta_found: 0, total_meta: 0, attempted_inserts: 0, insert_errors: [] as string[], created: 0 }

  if (missingKeys.length > 0) {
    editionsCreateDebug.missing_keys = missingKeys.length
    console.log("[wallet-enrich] missing_editions=" + missingKeys.length + " — attempting to create")

    // Gather metadata from badge_editions (has edition_id = edition_key)
    const badgeMeta = new Map<string, { playerName: string; setName: string; tier: string | null; series: number | null }>()
    for (let i = 0; i < missingKeys.length; i += CHUNK) {
      const chunk = missingKeys.slice(i, i + CHUNK)
      const { data: bRows, error: bErr } = await (supabaseAdmin as any)
        .from("badge_editions")
        .select("edition_id, player_name, set_name, tier, series_number")
        .in("edition_id", chunk)
      if (bErr) {
        console.log("[wallet-enrich] badge_editions lookup error: " + bErr.message)
      }
      for (const b of (bRows ?? [])) {
        if (b.player_name && !badgeMeta.has(b.edition_id)) {
          badgeMeta.set(b.edition_id, {
            playerName: b.player_name,
            setName: b.set_name ?? "Unknown Set",
            tier: b.tier ?? null,
            series: b.series_number != null ? Number(b.series_number) : null,
          })
        }
      }
    }
    console.log("[wallet-enrich] badge_meta_found=" + badgeMeta.size + "/" + missingKeys.length)
    editionsCreateDebug.badge_meta_found = badgeMeta.size

    // Also try wallet_moments_cache for any keys not found in badge_editions
    const stillMissing = missingKeys.filter(function (k) { return !badgeMeta.has(k) })
    if (stillMissing.length > 0) {
      for (let i = 0; i < stillMissing.length; i += CHUNK) {
        const chunk = stillMissing.slice(i, i + CHUNK)
        const { data: cRows, error: cErr } = await (supabaseAdmin as any)
          .from("wallet_moments_cache")
          .select("edition_key, player_name, set_name, tier, series_number")
          .in("edition_key", chunk)
        if (cErr) {
          console.log("[wallet-enrich] wallet_moments_cache metadata lookup error: " + cErr.message)
        } else {
          for (const c of (cRows ?? [])) {
            if (c.player_name && !badgeMeta.has(c.edition_key)) {
              badgeMeta.set(c.edition_key, {
                playerName: c.player_name,
                setName: c.set_name ?? "Unknown Set",
                tier: c.tier ?? null,
                series: c.series_number != null ? Number(c.series_number) : null,
              })
            }
          }
        }
      }
      console.log("[wallet-enrich] after wallet_cache fallback, total_meta=" + badgeMeta.size + "/" + missingKeys.length)
      editionsCreateDebug.wallet_cache_meta_found = badgeMeta.size - (editionsCreateDebug.badge_meta_found as number)
    }
    editionsCreateDebug.total_meta = badgeMeta.size

    // Build edition insert rows for keys where we found at least a player name
    const editionInserts: Array<{ external_id: string; collection_id: string; name: string; tier: string | null; series: number | null }> = []
    for (const key of missingKeys) {
      const meta = badgeMeta.get(key)
      if (meta) {
        editionInserts.push({
          external_id: key,
          collection_id: TS_COLLECTION_ID,
          name: meta.playerName + " — " + meta.setName,
          tier: meta.tier,
          series: meta.series,
        })
      }
    }

    // Bulk insert in chunks
    editionsCreateDebug.attempted_inserts = editionInserts.length
    if (editionInserts.length > 0) {
      console.log("[wallet-enrich] inserting " + editionInserts.length + " new edition rows")
      for (let i = 0; i < editionInserts.length; i += CHUNK) {
        const chunk = editionInserts.slice(i, i + CHUNK)
        const { data: inserted, error: insertErr } = await (supabaseAdmin as any)
          .from("editions")
          .upsert(chunk, { onConflict: "external_id", ignoreDuplicates: true })
          .select("id, external_id, collection_id, name, series, circulation_count")
        if (insertErr) {
          console.log("[wallet-enrich] edition insert error chunk " + Math.floor(i / CHUNK) + ": " + insertErr.message);
          (editionsCreateDebug.insert_errors as string[]).push("chunk " + Math.floor(i / CHUNK) + ": " + insertErr.message)
        } else {
          for (const r of (inserted ?? [])) {
            if (r.id) {
              editionUuidMap.set(r.external_id, { id: r.id, collectionId: r.collection_id ?? TS_COLLECTION_ID, name: r.name ?? "", series: r.series != null ? String(r.series) : null, circulationCount: r.circulation_count != null ? Number(r.circulation_count) : null, tier: r.tier ?? null })
              editionsCreated++
            }
          }
        }
      }
      console.log("[wallet-enrich] editions_created=" + editionsCreated + " edition_uuids_now=" + editionUuidMap.size)
    }
    editionsCreateDebug.created = editionsCreated
  }

  // Step 3: Fetch Flowty data (PRIMARY source) — 50 pages × 2 passes (blockTimestamp desc + salePrice asc)
  const { editionKeyMap: flowtyByKey, tierMatchMap: flowtyByTier, fullMatchMap: flowtyByFull, nameMatchMap: flowtyByName, debugSummary: flowtyDebug } = await fetchAllFlowtyData()
  console.log("[wallet-enrich] flowty: " + flowtyDebug.totalItems + " items across " + flowtyDebug.pagesFetched + " pages, " + flowtyByKey.size + " by editionKey, " + flowtyByTier.size + " by tierMatch, " + flowtyByFull.size + " by fullMatch, " + flowtyByName.size + " by name")

  // Step 4: Match wallet editions to Flowty data
  // Multi-level matching:
  //   1. Best: direct setID:playID edition key match
  //   2. Good: name + series + circulation_count (exact edition)
  //   3. OK: name + series (same player+set+series)
  //   4. Fallback: name only (may cross series)
  let flowtyKeyMatches = 0
  let flowtyTierMatches = 0
  let flowtyFullMatches = 0
  let flowtyNameSeriesMatches = 0
  let flowtyNameBaseMatches = 0
  let badgeMatches = 0
  let skippedNoUuid = 0
  let enriched = 0
  let tierUpdated = 0
  const upsertRows: Record<string, unknown>[] = []
  const tierUpdateRows: Array<{ id: string; tier: string }> = []
  const unmatchedEditions: Array<{ externalId: string; name: string; series: string | null }> = []

  for (const ek of uniqueKeys) {
    const edUuid = editionUuidMap.get(ek)
    if (!edUuid) { skippedNoUuid++; continue }

    let fl: FlowtyEditionData | undefined

    // Level 1: direct edition key match (setID:playID)
    fl = flowtyByKey.get(ek)
    if (fl) { flowtyKeyMatches++ }

    // Level 2+: name-based matching
    if (!fl) {
      const editionName = edUuid.name
      const parts = editionName ? editionName.split(" — ") : []
      const playerName = (parts[0] || "").trim()
      const setName = (parts.slice(1).join(" — ") || "").trim()

      // Level 2: name + series + circulation + tier (tightest)
      if (playerName && setName && edUuid.series && edUuid.circulationCount && edUuid.tier) {
        const tierKey = makeMatchKeyWithTier(playerName, setName, edUuid.series, edUuid.circulationCount, edUuid.tier)
        fl = flowtyByTier.get(tierKey)
        if (fl) flowtyTierMatches++
      }

      // Level 3: name + series + circulation_count
      if (!fl && playerName && setName && edUuid.series && edUuid.circulationCount) {
        const fullKey = makeMatchKeyWithCirculation(playerName, setName, edUuid.series, edUuid.circulationCount)
        fl = flowtyByFull.get(fullKey)
        if (fl) flowtyFullMatches++
      }

      // Level 4: name + series
      if (!fl && playerName && setName && edUuid.series) {
        const seriesKey = makeMatchKey(playerName, setName, edUuid.series)
        fl = flowtyByName.get(seriesKey)
        if (fl) flowtyNameSeriesMatches++
      }

      // Level 5: name only (worst, may cross series)
      if (!fl && editionName) {
        const baseKey = editionName.toLowerCase()
        fl = flowtyByName.get(baseKey)
        if (fl) flowtyNameBaseMatches++
      }
    }

    // If Flowty data has a tier and the edition is missing tier, queue an update
    if (fl && fl.tier && !edUuid.tier) {
      tierUpdateRows.push({ id: edUuid.id, tier: fl.tier })
    }

    if (fl) {
      // FMV = lowest listing price (flowtyAsk is already the lowest for this edition)
      const fmvUsd = fl.flowtyAsk
      const confidence = "LOW"
      upsertRows.push({
        edition_id: edUuid.id,
        collection_id: edUuid.collectionId,
        fmv_usd: fmvUsd,
        floor_price_usd: fl.flowtyAsk,
        flowty_ask: fl.flowtyAsk,
        cross_market_ask: fl.flowtyAsk,
        confidence,
        algo_version: "flowty-live",
        computed_at: new Date().toISOString(),
      })
      enriched++
    } else {
      // Track for badge fallback
      unmatchedEditions.push({ externalId: ek, name: edUuid.name, series: edUuid.series })
    }
  }

  // Step 5: Badge fallback — fetch ALL badge_editions once, match in JS
  let badgeDebug = { queriedEditions: 0, totalBadgeRows: 0, withLowAsk: 0, error: null as string | null }

  if (unmatchedEditions.length > 0) {
    badgeDebug.queriedEditions = unmatchedEditions.length

    // Fetch all badge_editions via RPC (bypasses PostgREST 1000-row cap)
    const { data: badgeRpcData, error: badgeErr } = await (supabaseAdmin as any)
      .rpc("get_all_badge_editions")

    if (badgeErr) {
      badgeDebug.error = badgeErr.message
      console.log("[wallet-enrich] badge_editions RPC error: " + badgeErr.message)
    } else {
      // Handle json_agg return: direct array, wrapper array, or JSON string
      let badgeRows: any[]
      if (Array.isArray(badgeRpcData) && badgeRpcData.length > 0 && Array.isArray(badgeRpcData[0])) {
        badgeRows = badgeRpcData[0]
      } else if (Array.isArray(badgeRpcData)) {
        badgeRows = badgeRpcData
      } else if (typeof badgeRpcData === "string") {
        badgeRows = JSON.parse(badgeRpcData)
      } else {
        badgeRows = []
      }
      console.log("[wallet-enrich] badge RPC returned " + badgeRows.length + " rows (type=" + typeof badgeRpcData + " isArray=" + Array.isArray(badgeRpcData) + ")")
      badgeDebug.totalBadgeRows = badgeRows.length

      // Build badge map keyed by series-aware key + base key
      const badgeMapSeries = new Map<string, number>()
      const badgeMapBase = new Map<string, number>()
      for (const b of badgeRows) {
        if (!b.player_name || !b.set_name || !b.low_ask || b.low_ask <= 0) continue
        const series = b.series_number != null ? String(b.series_number) : ""
        const seriesKey = makeMatchKey(b.player_name, b.set_name, series)
        const bKey = makeBaseKey(b.player_name, b.set_name)
        // Keep cheapest low_ask per key
        if (!badgeMapSeries.has(seriesKey) || b.low_ask < badgeMapSeries.get(seriesKey)!) {
          badgeMapSeries.set(seriesKey, b.low_ask)
        }
        if (!badgeMapBase.has(bKey) || b.low_ask < badgeMapBase.get(bKey)!) {
          badgeMapBase.set(bKey, b.low_ask)
        }
      }
      console.log("[wallet-enrich] badge map built: " + badgeMapSeries.size + " series keys, " + badgeMapBase.size + " base keys from " + badgeRows.length + " rows")

      for (const ed of unmatchedEditions) {
        if (!ed.name) continue
        const parts = ed.name.split(" — ")
        if (parts.length < 2) continue
        const playerName = parts[0].trim()
        const setName = parts.slice(1).join(" — ").trim()
        if (!playerName || !setName) continue

        // Try series-specific key first, fall back to base
        let lowAsk: number | undefined
        if (ed.series) {
          const sKey = makeMatchKey(playerName, setName, ed.series)
          lowAsk = badgeMapSeries.get(sKey)
        }
        if (lowAsk == null) {
          const bKey = makeBaseKey(playerName, setName)
          lowAsk = badgeMapBase.get(bKey)
        }

        if (lowAsk && lowAsk > 0) {
          badgeDebug.withLowAsk++
          badgeMatches++
          upsertRows.push({
            edition_id: editionUuidMap.get(ed.externalId)!.id,
            collection_id: editionUuidMap.get(ed.externalId)!.collectionId,
            fmv_usd: Number((lowAsk * 0.9).toFixed(2)),
            floor_price_usd: lowAsk,
            flowty_ask: null,
            cross_market_ask: lowAsk,
            confidence: "LOW",
            algo_version: "flowty-live",
            computed_at: new Date().toISOString(),
          })
          enriched++
        }
      }
    }
    console.log("[wallet-enrich] badge_editions fallback: " + badgeMatches + " matches (of " + unmatchedEditions.length + " unmatched)")
  }

  const totalFlowtyMatches = flowtyKeyMatches + flowtyTierMatches + flowtyFullMatches + flowtyNameSeriesMatches + flowtyNameBaseMatches
  console.log("[wallet-enrich] rows_to_write=" + upsertRows.length + " flowty_matches=" + totalFlowtyMatches + " (key=" + flowtyKeyMatches + " tier=" + flowtyTierMatches + " full=" + flowtyFullMatches + " nameSeries=" + flowtyNameSeriesMatches + " nameBase=" + flowtyNameBaseMatches + ") badge_matches=" + badgeMatches + " skipped_no_uuid=" + skippedNoUuid + " skipped_no_data=" + (unmatchedEditions.length - badgeMatches))
  if (totalFlowtyMatches === 0) {
    console.log("[wallet-enrich] WARNING: zero Flowty matches. page0 status=" + (flowtyDebug.pageDebug[0]?.httpStatus ?? "null") + " items=" + (flowtyDebug.pageDebug[0]?.itemCount ?? 0) + " error=" + (flowtyDebug.pageDebug[0]?.error ?? "none"))
  }

  // Step 6: Delete existing flowty-live rows, then insert new ones (chunks of 50)
  // Cannot use upsert — fmv_snapshots is partitioned by computed_at, so ON CONFLICT fails.
  let writeSucceeded = 0
  let writeErrors: string[] = []
  const WRITE_CHUNK = 50

  if (upsertRows.length > 0) {
    // Collect all edition_ids we're about to write
    const editionIdsToWrite = upsertRows.map(function (r) { return r.edition_id as string })

    // Delete existing flowty-live rows in chunks of 50
    for (let i = 0; i < editionIdsToWrite.length; i += WRITE_CHUNK) {
      const idChunk = editionIdsToWrite.slice(i, i + WRITE_CHUNK)
      const { error: delErr } = await (supabaseAdmin as any)
        .from("fmv_snapshots")
        .delete()
        .in("edition_id", idChunk)
        .eq("algo_version", "flowty-live")
      if (delErr) {
        writeErrors.push("delete chunk " + Math.floor(i / WRITE_CHUNK) + ": " + delErr.message)
        console.log("[wallet-enrich] delete error chunk " + Math.floor(i / WRITE_CHUNK) + ": " + delErr.message)
      }
    }
    console.log("[wallet-enrich] deleted old flowty-live rows for " + editionIdsToWrite.length + " editions")

    // Insert new rows in chunks of 50
    for (let i = 0; i < upsertRows.length; i += WRITE_CHUNK) {
      const chunk = upsertRows.slice(i, i + WRITE_CHUNK)
      const { data: inserted, error: insertErr } = await (supabaseAdmin as any)
        .from("fmv_snapshots")
        .insert(chunk)
        .select("edition_id")
      if (insertErr) {
        writeErrors.push("insert chunk " + Math.floor(i / WRITE_CHUNK) + ": " + insertErr.message)
        console.log("[wallet-enrich] insert error chunk " + Math.floor(i / WRITE_CHUNK) + ": " + insertErr.message)
        if (chunk.length > 0) console.log("[wallet-enrich] sample row: " + JSON.stringify(chunk[0]))
      } else {
        writeSucceeded += inserted?.length ?? chunk.length
      }
    }
  }

  // Step 7: Update edition tier from Flowty data where currently NULL
  if (tierUpdateRows.length > 0) {
    for (const row of tierUpdateRows) {
      const { error: tierErr } = await (supabaseAdmin as any)
        .from("editions")
        .update({ tier: row.tier })
        .eq("id", row.id)
        .is("tier", null)
      if (!tierErr) tierUpdated++
    }
    console.log("[wallet-enrich] tier backfill: " + tierUpdated + "/" + tierUpdateRows.length + " editions updated")
  }

  const duration = Date.now() - startTime
  console.log("[wallet-enrich] DONE: enriched=" + enriched + " written=" + writeSucceeded + " tierUpdated=" + tierUpdated + " errors=" + writeErrors.length + " duration=" + duration + "ms")

  // Summarize Flowty page debug: only include first page rawSample + any error pages
  const flowtyPageSummary = flowtyDebug.pageDebug
    .filter(function (p) { return p.from === 0 || p.error })
    .map(function (p) {
      return {
        from: p.from,
        sortPath: p.sortPath,
        httpStatus: p.httpStatus,
        error: p.error,
        responseKeys: p.responseKeys,
        itemCount: p.itemCount,
        parsedCount: p.parsedCount,
        rawSample: p.from === 0 ? p.rawSample : (p.error ? p.rawSample : null),
      }
    })

  // Build sample of 5 edition keys with their FMV for verification
  const sampleEditions: Array<{ editionKey: string; fmv_usd: number }> = []
  for (const row of upsertRows) {
    if (sampleEditions.length >= 5) break
    const ek = uniqueKeys.find(function (k) { return editionUuidMap.get(k)?.id === row.edition_id })
    if (ek) sampleEditions.push({ editionKey: ek, fmv_usd: row.fmv_usd as number })
  }

  const diagnostics = {
    ok: true,
    input: walletInput,
    wallet,
    unique_editions: uniqueKeys.length,
    editions_created: editionsCreated,
    editions_create_debug: editionsCreateDebug,
    edition_uuids_found: editionUuidMap.size,
    flowty_pages_fetched: flowtyDebug.pagesFetched,
    flowty_total_items: flowtyDebug.totalItems,
    unique_editions_found: flowtyByKey.size,
    flowty_name_editions: flowtyByName.size,
    flowty_key_matches: flowtyKeyMatches,
    flowty_tier_matches: flowtyTierMatches,
    flowty_full_matches: flowtyFullMatches,
    flowty_name_series_matches: flowtyNameSeriesMatches,
    flowty_name_base_matches: flowtyNameBaseMatches,
    flowty_total_matches: totalFlowtyMatches,
    flowty_request_url: flowtyDebug.requestUrl,
    flowty_http_status: flowtyDebug.pageDebug[0]?.httpStatus ?? null,
    flowty_error: flowtyDebug.pageDebug[0]?.error ?? null,
    flowty_raw_sample: flowtyDebug.pageDebug[0]?.rawSample ?? null,
    flowty_response_keys: flowtyDebug.pageDebug[0]?.responseKeys ?? null,
    flowty_page_debug: flowtyPageSummary,
    badge_debug: badgeDebug,
    badge_fallback_matches: badgeMatches,
    unmatched_editions: unmatchedEditions.length - badgeMatches,
    tier_updated: tierUpdated,
    fmv_rows_written: writeSucceeded,
    rows_built: upsertRows.length,
    write_errors: writeErrors.slice(0, 3),
    skipped_no_uuid: skippedNoUuid,
    sample_editions: sampleEditions,
    duration_ms: duration,
  }

  await (supabaseAdmin as any)
    .from("debug_logs")
    .insert({ route: "wallet-enrich-flowty", payload: diagnostics, created_at: new Date().toISOString() })
    .then(function () {})
    .catch(function () {})

  return NextResponse.json(diagnostics)
}
