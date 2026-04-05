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

// ── Flowty: same pattern as sniper-feed ────────────────────────────────────

function flattenTraits(raw: unknown): Array<{ name: string; value: string }> {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  const inner = (raw as Record<string, unknown>).traits ?? raw
  if (Array.isArray(inner)) return inner
  return Object.values(inner as Record<string, unknown>)
    .filter((v): v is { name: string; value: string } =>
      typeof v === "object" && v !== null && "name" in v)
}

type FlowtyEditionData = { flowtyAsk: number; livetokenFmv: number | null; playerName: string }

type FlowtyPageDebug = {
  from: number
  httpStatus: number | null
  error: string | null
  rawSample: string | null
  responseKeys: string | null
  itemCount: number
  parsedCount: number
}

async function fetchFlowtyPage(from: number): Promise<{ items: Array<{ editionKey: string; data: FlowtyEditionData }>; debug: FlowtyPageDebug }> {
  const items: Array<{ editionKey: string; data: FlowtyEditionData }> = []
  const debug: FlowtyPageDebug = { from, httpStatus: null, error: null, rawSample: null, responseKeys: null, itemCount: 0, parsedCount: 0 }

  const requestBody = {
    address: null, addresses: [],
    collectionFilters: [{ collection: "0x0b2a3299cc857e29.TopShot", traits: [] }],
    from, includeAllListings: true, limit: 24, onlyUnlisted: false,
    orderFilters: [{ conditions: [], kind: "storefront", paymentTokens: [] }],
    sort: { direction: "desc", listingKind: "storefront", path: "blockTimestamp" },
  }

  // Log exact request details on first page
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

    // Read raw text first so we can capture it regardless of parse success
    const rawText = await res.text()
    debug.rawSample = rawText.substring(0, 500)

    if (!res.ok) {
      debug.error = "HTTP " + res.status + " " + res.statusText
      console.log("[wallet-enrich] Flowty HTTP " + res.status + " from=" + from + " body=" + rawText.substring(0, 200))
      return { items, debug }
    }

    // Parse JSON from text
    let json: any
    try {
      json = JSON.parse(rawText)
    } catch (parseErr) {
      debug.error = "JSON parse failed: " + (parseErr instanceof Error ? parseErr.message : String(parseErr))
      console.log("[wallet-enrich] Flowty JSON parse error from=" + from + " raw=" + rawText.substring(0, 200))
      return { items, debug }
    }

    // Log response shape
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

      // Build edition key from SetID + PlayID (nft-level fields or traits)
      let setID = ""
      let playID = ""
      if (item.nftView?.setID) setID = String(item.nftView.setID)
      if (item.nftView?.playID) playID = String(item.nftView.playID)
      if (!setID) {
        for (const key of ["SetID", "setID", "setId", "Set ID"]) {
          const t = traits.find(function (t: { name: string }) { return t.name === key })
          if (t?.value) { setID = t.value; break }
        }
      }
      if (!playID) {
        for (const key of ["PlayID", "playID", "playId", "Play ID"]) {
          const t = traits.find(function (t: { name: string }) { return t.name === key })
          if (t?.value) { playID = t.value; break }
        }
      }

      if (!setID || !playID) continue
      const editionKey = setID + ":" + playID
      const playerName = item.card?.title ?? ""

      items.push({
        editionKey,
        data: {
          flowtyAsk: order.salePrice,
          livetokenFmv: livetokenFmv && livetokenFmv > 0 ? livetokenFmv : null,
          playerName,
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
      const existing = flowtyMap.get(item.editionKey)
      // Keep the cheapest ask per edition
      if (!existing || item.data.flowtyAsk < existing.flowtyAsk) {
        flowtyMap.set(item.editionKey, item.data)
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

  // Step 2: Resolve editions to internal UUIDs
  const editionUuidMap = new Map<string, { id: string; collectionId: string }>()
  const CHUNK = 200
  for (let i = 0; i < uniqueKeys.length; i += CHUNK) {
    const chunk = uniqueKeys.slice(i, i + CHUNK)
    const { data: rows } = await (supabaseAdmin as any)
      .from("editions")
      .select("id, external_id, collection_id")
      .in("external_id", chunk)
    for (const r of (rows ?? [])) {
      if (r.id) {
        editionUuidMap.set(r.external_id, { id: r.id, collectionId: r.collection_id ?? null })
      }
    }
  }
  console.log("[wallet-enrich] edition_uuid_resolved=" + editionUuidMap.size + "/" + uniqueKeys.length)

  // Step 3: Fetch Flowty data (PRIMARY source) — 10 pages
  const { flowtyMap, debugSummary: flowtyDebug } = await fetchAllFlowtyData()
  console.log("[wallet-enrich] flowty: " + flowtyDebug.totalItems + " items across 10 pages, " + flowtyMap.size + " unique editions")

  // Step 4: For editions NOT found on Flowty, try badge_editions fallback
  const missingKeys = uniqueKeys.filter(function (ek) { return !flowtyMap.has(ek) })
  const badgeFallbackMap = new Map<string, number>()
  let badgeDebug = { queriedKeys: 0, totalRows: 0, withLowAsk: 0, error: null as string | null }
  if (missingKeys.length > 0) {
    badgeDebug.queriedKeys = missingKeys.length
    for (let i = 0; i < missingKeys.length; i += CHUNK) {
      const chunk = missingKeys.slice(i, i + CHUNK)
      const { data: badgeRows, error: badgeErr } = await (supabaseAdmin as any)
        .from("badge_editions")
        .select("edition_key, low_ask")
        .in("edition_key", chunk)
      if (badgeErr) {
        badgeDebug.error = badgeErr.message
        console.log("[wallet-enrich] badge_editions error: " + badgeErr.message)
      }
      const rows = badgeRows ?? []
      badgeDebug.totalRows += rows.length
      for (const r of rows) {
        if (r.low_ask && r.low_ask > 0) {
          badgeDebug.withLowAsk++
          const existing = badgeFallbackMap.get(r.edition_key)
          if (!existing || r.low_ask < existing) {
            badgeFallbackMap.set(r.edition_key, r.low_ask)
          }
        }
      }
    }
    console.log("[wallet-enrich] badge_editions fallback: " + badgeFallbackMap.size + " editions with low_ask (of " + missingKeys.length + " missing, " + badgeDebug.totalRows + " rows returned)")
  }

  // Step 5: Build fmv_snapshots upsert rows
  let enriched = 0
  let skippedNoUuid = 0
  let skippedNoData = 0
  let flowtyMatches = 0
  let badgeMatches = 0
  const upsertRows: Record<string, unknown>[] = []

  for (const ek of uniqueKeys) {
    const edUuid = editionUuidMap.get(ek)
    if (!edUuid) { skippedNoUuid++; continue }

    const fl = flowtyMap.get(ek)
    const badgeLowAsk = badgeFallbackMap.get(ek) ?? null

    if (!fl && !badgeLowAsk) { skippedNoData++; continue }

    let fmvUsd: number | null = null
    let floorPriceUsd: number | null = null
    let confidence: string = "LOW"
    let flowtyAsk: number | null = null

    if (fl) {
      // Flowty data available
      flowtyMatches++
      flowtyAsk = fl.flowtyAsk
      floorPriceUsd = fl.flowtyAsk
      if (fl.livetokenFmv) {
        fmvUsd = fl.livetokenFmv
        confidence = "MEDIUM"
      } else {
        // Use ask price * 0.9 as FMV proxy
        fmvUsd = Number((fl.flowtyAsk * 0.9).toFixed(2))
        confidence = "LOW"
      }
    } else if (badgeLowAsk) {
      // Badge fallback
      badgeMatches++
      floorPriceUsd = badgeLowAsk
      fmvUsd = Number((badgeLowAsk * 0.9).toFixed(2))
      confidence = "LOW"
    }

    upsertRows.push({
      edition_id: edUuid.id,
      collection_id: edUuid.collectionId,
      fmv_usd: fmvUsd,
      floor_price_usd: floorPriceUsd,
      flowty_ask: flowtyAsk,
      cross_market_ask: floorPriceUsd,
      confidence,
      algo_version: "flowty-live",
      computed_at: new Date().toISOString(),
    })
    enriched++
  }

  console.log("[wallet-enrich] rows_to_write=" + upsertRows.length + " flowty_matches=" + flowtyMatches + " badge_matches=" + badgeMatches + " skipped_no_uuid=" + skippedNoUuid + " skipped_no_data=" + skippedNoData)
  if (flowtyMatches === 0) {
    console.log("[wallet-enrich] WARNING: zero Flowty matches. page0 status=" + (flowtyDebug.pageDebug[0]?.httpStatus ?? "null") + " items=" + (flowtyDebug.pageDebug[0]?.itemCount ?? 0) + " error=" + (flowtyDebug.pageDebug[0]?.error ?? "none"))
  }

  // Step 6: Upsert into fmv_snapshots with ON CONFLICT (edition_id) DO UPDATE
  let upsertSucceeded = 0
  let upsertErrors: string[] = []

  if (upsertRows.length > 0) {
    for (let i = 0; i < upsertRows.length; i += CHUNK) {
      const chunk = upsertRows.slice(i, i + CHUNK)
      const { data: inserted, error: upsertErr } = await (supabaseAdmin as any)
        .from("fmv_snapshots")
        .upsert(chunk, { onConflict: "edition_id" })
        .select("edition_id")
      if (upsertErr) {
        upsertErrors.push(upsertErr.message)
        console.log("[wallet-enrich] upsert error chunk " + Math.floor(i / CHUNK) + ": " + upsertErr.message)
        if (chunk.length > 0) console.log("[wallet-enrich] sample row: " + JSON.stringify(chunk[0]))
      } else {
        upsertSucceeded += inserted?.length ?? chunk.length
      }
    }
  }

  const duration = Date.now() - startTime
  console.log("[wallet-enrich] DONE: enriched=" + enriched + " upserted=" + upsertSucceeded + " errors=" + upsertErrors.length + " duration=" + duration + "ms")

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
    edition_uuids_found: editionUuidMap.size,
    flowty_total_items: flowtyDebug.totalItems,
    flowty_unique_editions: flowtyMap.size,
    flowty_wallet_matches: flowtyMatches,
    flowty_request_url: flowtyDebug.requestUrl,
    flowty_request_headers: flowtyDebug.requestHeaders,
    flowty_http_status: flowtyDebug.pageDebug[0]?.httpStatus ?? null,
    flowty_error: flowtyDebug.pageDebug[0]?.error ?? null,
    flowty_raw_sample: flowtyDebug.pageDebug[0]?.rawSample ?? null,
    flowty_response_keys: flowtyDebug.pageDebug[0]?.responseKeys ?? null,
    flowty_page_debug: flowtyPageSummary,
    badge_debug: badgeDebug,
    badge_fallback_matches: badgeMatches,
    rows_built: upsertRows.length,
    rows_upserted: upsertSucceeded,
    upsert_errors: upsertErrors.slice(0, 3),
    skipped_no_uuid: skippedNoUuid,
    skipped_no_data: skippedNoData,
    duration_ms: duration,
  }

  await (supabaseAdmin as any)
    .from("debug_logs")
    .insert({ route: "wallet-enrich-flowty", payload: diagnostics, created_at: new Date().toISOString() })
    .then(function () {})
    .catch(function () {})

  return NextResponse.json(diagnostics)
}
