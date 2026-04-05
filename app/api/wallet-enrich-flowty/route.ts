import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

/**
 * POST /api/wallet-enrich-flowty
 *
 * Enriches a collector's wallet with live FMV and Low Ask data:
 * - Top Shot lowest asks from ts_listings table (populated by ts-listing-ingest)
 * - Flowty floor prices + LiveToken FMV from Flowty API (same pattern as sniper-feed)
 * Writes results as fmv_snapshots with algo_version 'flowty-live'.
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

// ── Top Shot: get lowest ask per edition from ts_listings table ──────────────
// Uses the same data source as the sniper feed — no GQL calls needed.

async function fetchTopShotAsks(
  editionKeys: Set<string>
): Promise<{ askMap: Map<string, number>; debug: string }> {
  const askMap = new Map<string, number>()
  try {
    // ts_listings has set_id + play_id columns. Fetch all current listings.
    const { data: rows, error } = await (supabaseAdmin as any)
      .from("ts_listings")
      .select("set_id, play_id, price_usd")
      .order("price_usd", { ascending: true })
      .limit(5000)

    if (error) return { askMap, debug: "ts_listings error: " + error.message }
    if (!rows?.length) return { askMap, debug: "ts_listings: 0 rows" }

    // Build lowest ask per edition key
    for (const r of rows) {
      if (!r.set_id || !r.play_id || !r.price_usd || r.price_usd <= 0) continue
      const ek = r.set_id + ":" + r.play_id
      if (!editionKeys.has(ek)) continue
      if (!askMap.has(ek)) {
        askMap.set(ek, Number(r.price_usd))
      }
    }
    return { askMap, debug: "ts_listings: " + rows.length + " rows, " + askMap.size + " matched" }
  } catch (err) {
    return { askMap, debug: "ts_listings exception: " + (err instanceof Error ? err.message : String(err)) }
  }
}

// ── Flowty: exact same pattern as sniper-feed fetchFlowtyPage ───────────────

const FLOWTY_TRAIT_MAP: Record<string, string[]> = {
  setName: ["SetName", "setName", "Set Name", "set_name"],
  tier: ["Tier", "tier", "MomentTier", "momentTier"],
  seriesNumber: ["SeriesNumber", "seriesNumber", "Series Number", "series_number", "Series"],
  fullName: ["FullName", "fullName", "Full Name", "PlayerName", "playerName"],
}

function flattenTraits(raw: unknown): Array<{ name: string; value: string }> {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  const inner = (raw as Record<string, unknown>).traits ?? raw
  if (Array.isArray(inner)) return inner
  return Object.values(inner as Record<string, unknown>)
    .filter((v): v is { name: string; value: string } =>
      typeof v === "object" && v !== null && "name" in v)
}

function getTraitMulti(traits: Array<{ name: string; value: string }>, keys: string[]): string {
  for (const key of keys) {
    const found = traits.find(function (t) { return t.name === key })
    if (found?.value) return found.value
  }
  return ""
}

type FlowtyEditionData = { flowtyAsk: number | null; livetokenFmv: number | null; playerName: string }

async function fetchFlowtyPage(from: number): Promise<Array<{ editionKey: string; data: FlowtyEditionData }>> {
  const results: Array<{ editionKey: string; data: FlowtyEditionData }> = []
  try {
    const controller = new AbortController()
    const timeout = setTimeout(function () { controller.abort() }, 10000)
    const res = await fetch(FLOWTY_ENDPOINT, {
      method: "POST",
      headers: FLOWTY_HEADERS,
      body: JSON.stringify({
        address: null, addresses: [],
        collectionFilters: [{ collection: "0x0b2a3299cc857e29.TopShot", traits: [] }],
        from, includeAllListings: true, limit: 24, onlyUnlisted: false,
        orderFilters: [{ conditions: [], kind: "storefront", paymentTokens: [] }],
        sort: { direction: "desc", listingKind: "storefront", path: "blockTimestamp" },
      }),
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!res.ok) return results
    const json = await res.json()
    const rawItems: any[] = json?.nfts ?? json?.data ?? []

    if (from === 0 && rawItems.length > 0) {
      const firstTraits = flattenTraits(rawItems[0].nftView?.traits)
      console.log("[wallet-enrich] Flowty trait keys: " + firstTraits.map(function (t: { name: string }) { return t.name }).join(", "))
    }

    for (const item of rawItems) {
      const order = item.orders?.find(function (o: any) { return (o.salePrice ?? 0) > 0 }) ?? item.orders?.[0]
      if (!order || order.salePrice <= 0) continue
      const traits = flattenTraits(item.nftView?.traits)
      const livetokenFmv = item.valuations?.blended?.usdValue ?? item.valuations?.livetoken?.usdValue ?? null

      // Build edition key from card fields or traits
      // Flowty nft has nftView.traits with SetID/PlayID
      let setID = ""
      let playID = ""
      // Try nft-level fields first
      if (item.nftView?.setID) setID = String(item.nftView.setID)
      if (item.nftView?.playID) playID = String(item.nftView.playID)
      // Fallback to traits
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
      const playerName = item.card?.title ?? getTraitMulti(traits, FLOWTY_TRAIT_MAP.fullName) ?? ""

      results.push({
        editionKey,
        data: {
          flowtyAsk: order.salePrice > 0 ? order.salePrice : null,
          livetokenFmv: livetokenFmv && livetokenFmv > 0 ? livetokenFmv : null,
          playerName,
        },
      })
    }
    return results
  } catch {
    return results
  }
}

async function fetchAllFlowtyData(targetEditionKeys: Set<string>): Promise<{ flowtyMap: Map<string, FlowtyEditionData>; debug: string }> {
  const flowtyMap = new Map<string, FlowtyEditionData>()
  try {
    // Same 5-page parallel fetch as sniper-feed
    const pages = await Promise.all([
      fetchFlowtyPage(0), fetchFlowtyPage(24),
      fetchFlowtyPage(48), fetchFlowtyPage(72),
      fetchFlowtyPage(96),
    ])

    let totalItems = 0
    for (const page of pages) {
      totalItems += page.length
      for (const item of page) {
        if (!targetEditionKeys.has(item.editionKey)) continue
        if (flowtyMap.has(item.editionKey)) continue // keep cheapest (first seen)
        flowtyMap.set(item.editionKey, item.data)
      }
    }

    return { flowtyMap, debug: "flowty: " + totalItems + " items across 5 pages, " + flowtyMap.size + " matched" }
  } catch (err) {
    return { flowtyMap, debug: "flowty exception: " + (err instanceof Error ? err.message : String(err)) }
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
      if (r.collection_id) {
        editionUuidMap.set(r.external_id, { id: r.id, collectionId: r.collection_id })
      }
    }
  }
  console.log("[wallet-enrich] edition_uuid_resolved=" + editionUuidMap.size + "/" + uniqueKeys.length)

  // Step 3: Fetch market data in parallel
  const [tsResult, flowtyResult] = await Promise.all([
    fetchTopShotAsks(keySet),
    fetchAllFlowtyData(keySet),
  ])

  console.log("[wallet-enrich] " + tsResult.debug)
  console.log("[wallet-enrich] " + flowtyResult.debug)

  // Step 4: Build fmv_snapshots rows
  let enriched = 0
  let skippedNoUuid = 0
  let skippedNoData = 0
  const upsertRows: Record<string, unknown>[] = []

  for (const ek of uniqueKeys) {
    const edUuid = editionUuidMap.get(ek)
    if (!edUuid) { skippedNoUuid++; continue }

    const topShotAsk = tsResult.askMap.get(ek) ?? null
    const fl = flowtyResult.flowtyMap.get(ek)
    const flowtyAsk = fl?.flowtyAsk ?? null
    const livetokenFmv = fl?.livetokenFmv ?? null

    const crossMarketAsk = topShotAsk !== null && flowtyAsk !== null
      ? Math.min(topShotAsk, flowtyAsk)
      : topShotAsk ?? flowtyAsk

    if (!topShotAsk && !flowtyAsk && !livetokenFmv) { skippedNoData++; continue }

    const fmvUsd = livetokenFmv ?? (crossMarketAsk ? Number((crossMarketAsk * 0.9).toFixed(2)) : null)
    const confidence = livetokenFmv ? "LOW" : "ASK_ONLY"

    upsertRows.push({
      edition_id: edUuid.id,
      collection_id: edUuid.collectionId,
      fmv_usd: fmvUsd,
      floor_price_usd: crossMarketAsk,
      top_shot_ask: topShotAsk,
      flowty_ask: flowtyAsk,
      cross_market_ask: crossMarketAsk,
      confidence,
      sales_count_7d: 0,
      sales_count_30d: 0,
      algo_version: "flowty-live",
    })
    enriched++
  }

  console.log("[wallet-enrich] rows_to_write=" + upsertRows.length + " skipped_no_uuid=" + skippedNoUuid + " skipped_no_data=" + skippedNoData)

  // Step 5: Delete old flowty-live snapshots then insert fresh
  let insertSucceeded = 0
  let insertErrors: string[] = []

  if (upsertRows.length > 0) {
    const editionIds = upsertRows.map(function (r) { return r.edition_id as string })

    const { error: delErr } = await (supabaseAdmin as any)
      .from("fmv_snapshots")
      .delete()
      .in("edition_id", editionIds)
      .eq("algo_version", "flowty-live")
    if (delErr) console.log("[wallet-enrich] delete error:", delErr.message)

    for (let i = 0; i < upsertRows.length; i += CHUNK) {
      const chunk = upsertRows.slice(i, i + CHUNK)
      const { data: inserted, error: insertErr } = await (supabaseAdmin as any)
        .from("fmv_snapshots")
        .insert(chunk)
        .select("id")
      if (insertErr) {
        insertErrors.push(insertErr.message)
        console.log("[wallet-enrich] insert error chunk " + Math.floor(i / CHUNK) + ": " + insertErr.message)
        if (chunk.length > 0) console.log("[wallet-enrich] sample row: " + JSON.stringify(chunk[0]))
      } else {
        insertSucceeded += inserted?.length ?? chunk.length
      }
    }
  }

  const duration = Date.now() - startTime
  console.log("[wallet-enrich] DONE: enriched=" + enriched + " inserted=" + insertSucceeded + " errors=" + insertErrors.length + " duration=" + duration + "ms")

  const diagnostics = {
    ok: true,
    input: walletInput,
    wallet,
    unique_editions: uniqueKeys.length,
    edition_uuids_found: editionUuidMap.size,
    ts_debug: tsResult.debug,
    ts_asks_found: tsResult.askMap.size,
    flowty_debug: flowtyResult.debug,
    flowty_data_found: flowtyResult.flowtyMap.size,
    rows_built: upsertRows.length,
    rows_inserted: insertSucceeded,
    insert_errors: insertErrors.slice(0, 3),
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
