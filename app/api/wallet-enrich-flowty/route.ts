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

type FlowtyEditionData = { flowtyAsk: number; livetokenFmv: number | null; playerName: string; setName: string }

type FlowtyPageDebug = {
  from: number
  httpStatus: number | null
  error: string | null
  rawSample: string | null
  responseKeys: string | null
  itemCount: number
  parsedCount: number
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

async function fetchFlowtyPage(from: number): Promise<{ items: Array<{ matchKey: string; baseKey: string; data: FlowtyEditionData }>; debug: FlowtyPageDebug }> {
  const items: Array<{ matchKey: string; baseKey: string; data: FlowtyEditionData }> = []
  const debug: FlowtyPageDebug = { from, httpStatus: null, error: null, rawSample: null, responseKeys: null, itemCount: 0, parsedCount: 0 }

  const requestBody = {
    address: null, addresses: [],
    collectionFilters: [{ collection: "0x0b2a3299cc857e29.TopShot", traits: [] }],
    from, includeAllListings: true, limit: 24, onlyUnlisted: false,
    orderFilters: [{ conditions: [], kind: "storefront", paymentTokens: [] }],
    sort: { direction: "desc", listingKind: "storefront", path: "blockTimestamp" },
  }

  if (from === 0) {
    console.log("[wallet-enrich] Flowty URL: " + FLOWTY_ENDPOINT)
    console.log("[wallet-enrich] Flowty headers: " + JSON.stringify(FLOWTY_HEADERS))
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
      console.log("[wallet-enrich] Flowty HTTP " + res.status + " from=" + from + " body=" + rawText.substring(0, 200))
      return { items, debug }
    }

    let json: any
    try {
      json = JSON.parse(rawText)
    } catch (parseErr) {
      debug.error = "JSON parse failed: " + (parseErr instanceof Error ? parseErr.message : String(parseErr))
      console.log("[wallet-enrich] Flowty JSON parse error from=" + from + " raw=" + rawText.substring(0, 200))
      return { items, debug }
    }

    const topKeys = Object.keys(json ?? {})
    debug.responseKeys = topKeys.join(", ")

    const rawItems: any[] = json?.nfts ?? json?.data ?? []
    debug.itemCount = rawItems.length

    if (from === 0) {
      console.log("[wallet-enrich] Flowty response keys: " + topKeys.join(", "))
      console.log("[wallet-enrich] Flowty page 0 rawItems=" + rawItems.length)
      if (rawItems.length === 0) {
        console.log("[wallet-enrich] Flowty page 0 EMPTY — full response keys: " + topKeys.join(", ") + " nfts type: " + typeof json?.nfts + " data type: " + typeof json?.data)
      }
      if (rawItems.length > 0) {
        const firstTraits = flattenTraits(rawItems[0].nftView?.traits)
        console.log("[wallet-enrich] Flowty trait keys: " + firstTraits.map(function (t: { name: string }) { return t.name }).join(", "))
        console.log("[wallet-enrich] Flowty first item keys: " + Object.keys(rawItems[0]).join(", "))
      }
    }

    for (const item of rawItems) {
      const order = item.orders?.find(function (o: any) { return (o.salePrice ?? 0) > 0 }) ?? item.orders?.[0]
      if (!order || order.salePrice <= 0) continue
      const traits = flattenTraits(item.nftView?.traits)
      const livetokenFmv = item.valuations?.blended?.usdValue ?? item.valuations?.livetoken?.usdValue ?? null

      // Extract player name from card.title, set name + series from traits
      const playerName = item.card?.title ?? getTraitMulti(traits, FLOWTY_TRAIT_MAP.fullName) ?? ""
      const setName = getTraitMulti(traits, FLOWTY_TRAIT_MAP.setName)
      const seriesNumber = getTraitMulti(traits, FLOWTY_TRAIT_MAP.seriesNumber)

      if (!playerName || !setName) continue

      const matchKey = makeMatchKey(playerName, setName, seriesNumber)
      const baseKey = makeBaseKey(playerName, setName)

      items.push({
        matchKey,
        baseKey,
        data: {
          flowtyAsk: order.salePrice,
          livetokenFmv: livetokenFmv && livetokenFmv > 0 ? livetokenFmv : null,
          playerName,
          setName,
        },
      })
    }
    debug.parsedCount = items.length
    return { items, debug }
  } catch (err) {
    debug.error = "exception: " + (err instanceof Error ? err.message : String(err))
    console.log("[wallet-enrich] Flowty from=" + from + " exception: " + (err instanceof Error ? err.message : String(err)))
    return { items, debug }
  }
}

type FlowtyDebugSummary = {
  totalItems: number
  uniqueEditions: number
  pageDebug: FlowtyPageDebug[]
  requestUrl: string
  requestHeaders: Record<string, string>
}

async function fetchAllFlowtyData(): Promise<{ flowtyMap: Map<string, FlowtyEditionData>; debugSummary: FlowtyDebugSummary }> {
  const flowtyMap = new Map<string, FlowtyEditionData>()
  // 10 pages = ~240 listings
  const offsets = [0, 24, 48, 72, 96, 120, 144, 168, 192, 216]
  const pageResults = await Promise.all(offsets.map(function (o) { return fetchFlowtyPage(o) }))

  let totalItems = 0
  const pageDebug: FlowtyPageDebug[] = []
  for (const page of pageResults) {
    pageDebug.push(page.debug)
    totalItems += page.items.length
    for (const item of page.items) {
      // Store under series-specific key (primary)
      const existing = flowtyMap.get(item.matchKey)
      if (!existing || item.data.flowtyAsk < existing.flowtyAsk) {
        flowtyMap.set(item.matchKey, item.data)
      }
      // Also store under base key (name-only fallback) — only if no series-specific entry exists
      if (!flowtyMap.has(item.baseKey)) {
        flowtyMap.set(item.baseKey, item.data)
      } else {
        const existingBase = flowtyMap.get(item.baseKey)!
        if (item.data.flowtyAsk < existingBase.flowtyAsk) {
          flowtyMap.set(item.baseKey, item.data)
        }
      }
    }
  }

  return {
    flowtyMap,
    debugSummary: {
      totalItems,
      uniqueEditions: flowtyMap.size,
      pageDebug,
      requestUrl: FLOWTY_ENDPOINT,
      requestHeaders: FLOWTY_HEADERS,
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

  // Step 1: Get unique edition_keys for this wallet
  const { data: cacheRows, error: cacheErr } = await (supabaseAdmin as any)
    .from("wallet_moments_cache")
    .select("edition_key")
    .eq("wallet_address", wallet)
    .not("edition_key", "is", null)

  if (cacheErr || !cacheRows?.length) {
    const diag = { ok: true, enriched: 0, reason: cacheErr ? "cache error: " + cacheErr.message : "no editions", wallet, input: walletInput }
    await (supabaseAdmin as any).from("debug_logs").insert({ route: "wallet-enrich-flowty", payload: diag }).catch(function () {})
    return NextResponse.json(diag)
  }

  const keySet = new Set<string>()
  for (const r of cacheRows) { keySet.add((r as any).edition_key as string) }
  const uniqueKeys = Array.from(keySet)
  console.log("[wallet-enrich] wallet=" + wallet + " unique_editions=" + uniqueKeys.length)

  // Step 2: Resolve editions to internal UUIDs + names + series
  const editionUuidMap = new Map<string, { id: string; collectionId: string; name: string; series: string | null }>()
  const CHUNK = 800
  for (let i = 0; i < uniqueKeys.length; i += CHUNK) {
    const chunk = uniqueKeys.slice(i, i + CHUNK)
    const { data: rows } = await (supabaseAdmin as any)
      .from("editions")
      .select("id, external_id, collection_id, name, series")
      .in("external_id", chunk)
    for (const r of (rows ?? [])) {
      if (r.id) {
        editionUuidMap.set(r.external_id, { id: r.id, collectionId: r.collection_id ?? null, name: r.name ?? "", series: r.series != null ? String(r.series) : null })
      }
    }
  }
  console.log("[wallet-enrich] edition_uuid_resolved=" + editionUuidMap.size + "/" + uniqueKeys.length)

  // Step 2b: Create missing editions on the fly
  const TS_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
  const missingKeys = uniqueKeys.filter(function (k) { return !editionUuidMap.has(k) })
  let editionsCreated = 0

  if (missingKeys.length > 0) {
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
    }

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
    if (editionInserts.length > 0) {
      console.log("[wallet-enrich] inserting " + editionInserts.length + " new edition rows")
      for (let i = 0; i < editionInserts.length; i += CHUNK) {
        const chunk = editionInserts.slice(i, i + CHUNK)
        const { data: inserted, error: insertErr } = await (supabaseAdmin as any)
          .from("editions")
          .upsert(chunk, { onConflict: "external_id", ignoreDuplicates: true })
          .select("id, external_id, collection_id, name, series")
        if (insertErr) {
          console.log("[wallet-enrich] edition insert error chunk " + Math.floor(i / CHUNK) + ": " + insertErr.message)
        } else {
          for (const r of (inserted ?? [])) {
            if (r.id) {
              editionUuidMap.set(r.external_id, { id: r.id, collectionId: r.collection_id ?? TS_COLLECTION_ID, name: r.name ?? "", series: r.series != null ? String(r.series) : null })
              editionsCreated++
            }
          }
        }
      }
      console.log("[wallet-enrich] editions_created=" + editionsCreated + " edition_uuids_now=" + editionUuidMap.size)
    }
  }

  // Step 3: Fetch Flowty data (PRIMARY source) — 10 pages
  // Flowty doesn't have SetID/PlayID traits, so we match by player name + set name
  const { flowtyMap, debugSummary: flowtyDebug } = await fetchAllFlowtyData()
  console.log("[wallet-enrich] flowty: " + flowtyDebug.totalItems + " items across 10 pages, " + flowtyMap.size + " unique editions")

  // Step 4: Match wallet editions to Flowty data by name + series
  // editions.name is in "Player Name — Set Name" format; series disambiguates same-name editions
  let flowtyMatches = 0
  let flowtySeriesMatches = 0
  let flowtyBaseMatches = 0
  let badgeMatches = 0
  let skippedNoUuid = 0
  let skippedNoData = 0
  let enriched = 0
  const upsertRows: Record<string, unknown>[] = []
  const unmatchedEditions: Array<{ externalId: string; name: string; series: string | null }> = []

  for (const ek of uniqueKeys) {
    const edUuid = editionUuidMap.get(ek)
    if (!edUuid) { skippedNoUuid++; continue }

    // Build match key from edition name + series (try series-specific first, fall back to name-only)
    const editionName = edUuid.name
    const baseKey = editionName ? editionName.toLowerCase() : ""
    const seriesKey = (editionName && edUuid.series) ? makeMatchKey(editionName.split(" — ")[0] || "", editionName.split(" — ").slice(1).join(" — ") || "", edUuid.series) : ""
    let fl: FlowtyEditionData | undefined
    if (seriesKey) {
      fl = flowtyMap.get(seriesKey)
      if (fl) flowtySeriesMatches++
    }
    if (!fl && baseKey) {
      fl = flowtyMap.get(baseKey)
      if (fl) flowtyBaseMatches++
    }

    if (fl) {
      flowtyMatches++
      let fmvUsd: number | null = null
      let confidence: string = "LOW"
      if (fl.livetokenFmv) {
        fmvUsd = fl.livetokenFmv
        confidence = "MEDIUM"
      } else {
        fmvUsd = Number((fl.flowtyAsk * 0.9).toFixed(2))
        confidence = "LOW"
      }
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
      unmatchedEditions.push({ externalId: ek, name: editionName, series: edUuid.series })
    }
  }

  // Step 5: Badge fallback — fetch ALL badge_editions once, match in JS
  let badgeDebug = { queriedEditions: 0, totalBadgeRows: 0, withLowAsk: 0, error: null as string | null }

  if (unmatchedEditions.length > 0) {
    badgeDebug.queriedEditions = unmatchedEditions.length

    // Single query to fetch entire badge_editions table (small — hundreds of rows)
    const { data: allBadges, error: badgeErr } = await (supabaseAdmin as any)
      .from("badge_editions")
      .select("player_name, set_name, series_number, low_ask")

    if (badgeErr) {
      badgeDebug.error = badgeErr.message
      console.log("[wallet-enrich] badge_editions fetch error: " + badgeErr.message)
    } else {
      const badgeRows = allBadges ?? []
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

  console.log("[wallet-enrich] rows_to_write=" + upsertRows.length + " flowty_matches=" + flowtyMatches + " (series=" + flowtySeriesMatches + " base=" + flowtyBaseMatches + ") badge_matches=" + badgeMatches + " skipped_no_uuid=" + skippedNoUuid + " skipped_no_data=" + (unmatchedEditions.length - badgeMatches))
  if (flowtyMatches === 0) {
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

  const duration = Date.now() - startTime
  console.log("[wallet-enrich] DONE: enriched=" + enriched + " written=" + writeSucceeded + " errors=" + writeErrors.length + " duration=" + duration + "ms")

  // Summarize Flowty page debug: only include first page rawSample + any error pages
  const flowtyPageSummary = flowtyDebug.pageDebug.map(function (p) {
    return {
      from: p.from,
      httpStatus: p.httpStatus,
      error: p.error,
      responseKeys: p.responseKeys,
      itemCount: p.itemCount,
      parsedCount: p.parsedCount,
      rawSample: p.from === 0 ? p.rawSample : (p.error ? p.rawSample : null),
    }
  })

  const diagnostics = {
    ok: true,
    input: walletInput,
    wallet,
    unique_editions: uniqueKeys.length,
    editions_created: editionsCreated,
    edition_uuids_found: editionUuidMap.size,
    flowty_total_items: flowtyDebug.totalItems,
    flowty_unique_editions: flowtyMap.size,
    flowty_wallet_matches: flowtyMatches,
    flowty_series_matches: flowtySeriesMatches,
    flowty_base_matches: flowtyBaseMatches,
    flowty_request_url: flowtyDebug.requestUrl,
    flowty_request_headers: flowtyDebug.requestHeaders,
    flowty_http_status: flowtyDebug.pageDebug[0]?.httpStatus ?? null,
    flowty_error: flowtyDebug.pageDebug[0]?.error ?? null,
    flowty_raw_sample: flowtyDebug.pageDebug[0]?.rawSample ?? null,
    flowty_response_keys: flowtyDebug.pageDebug[0]?.responseKeys ?? null,
    flowty_page_debug: flowtyPageSummary,
    badge_debug: badgeDebug,
    badge_fallback_matches: badgeMatches,
    unmatched_editions: unmatchedEditions.length - badgeMatches,
    rows_built: upsertRows.length,
    rows_written: writeSucceeded,
    write_errors: writeErrors.slice(0, 3),
    skipped_no_uuid: skippedNoUuid,
    duration_ms: duration,
  }

  await (supabaseAdmin as any)
    .from("debug_logs")
    .insert({ route: "wallet-enrich-flowty", payload: diagnostics, created_at: new Date().toISOString() })
    .then(function () {})
    .catch(function () {})

  return NextResponse.json(diagnostics)
}
