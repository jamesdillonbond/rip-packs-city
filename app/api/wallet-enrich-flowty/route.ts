import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

/**
 * POST /api/wallet-enrich-flowty
 *
 * For each unique edition in a wallet, fetches live Low Ask from Top Shot GQL
 * (searchEditions → lowestAsk) and LiveToken FMV + Flowty floor from Flowty API.
 * Upserts results into fmv_snapshots so the collection page shows real prices.
 *
 * Body: { wallet: string }
 * Auth: Bearer INGEST_SECRET_TOKEN (for cron), or no auth (for client fire-and-forget)
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
  Origin: "https://www.flowty.io",
  Referer: "https://www.flowty.io/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36",
}

// Top Shot GQL: batch-fetch lowestAsk for multiple editions at once
const SEARCH_EDITIONS_QUERY = `
  query SearchEditionListings($input: SearchEditionsInput!) {
    searchEditions(input: $input) {
      data {
        searchSummary {
          data {
            ... on Editions {
              data {
                ... on Edition {
                  setID
                  playID
                  lowestAsk
                  circulationCount
                  forSaleCount
                }
              }
            }
          }
        }
      }
    }
  }
`

type EditionAsk = {
  editionKey: string
  setID: string
  playID: string
  lowestAsk: number | null
  circulationCount: number | null
}

async function fetchTopShotAsks(editions: { setID: string; playID: string; editionKey: string }[]): Promise<Map<string, EditionAsk>> {
  const result = new Map<string, EditionAsk>()
  // Top Shot searchEditions only accepts one edition at a time, so batch with concurrency
  const CONCURRENCY = 8
  for (let i = 0; i < editions.length; i += CONCURRENCY) {
    const batch = editions.slice(i, i + CONCURRENCY)
    const promises = batch.map(async function (ed) {
      try {
        const res = await fetch(TOPSHOT_GQL, {
          method: "POST",
          headers: GQL_HEADERS,
          body: JSON.stringify({
            query: SEARCH_EDITIONS_QUERY,
            variables: {
              input: {
                filters: { bySetID: ed.setID, byPlayID: ed.playID },
                searchInput: { pagination: { cursor: "", direction: "RIGHT", limit: 1 } },
              },
            },
          }),
          signal: AbortSignal.timeout(8000),
        })
        if (!res.ok) {
          if (i === 0) console.log("[wallet-enrich-flowty] TS GQL HTTP " + res.status + " for " + ed.editionKey)
          return
        }
        const json = await res.json()
        if (json.errors?.length) {
          if (i === 0) console.log("[wallet-enrich-flowty] TS GQL errors for " + ed.editionKey + ": " + JSON.stringify(json.errors).slice(0, 200))
          return
        }
        const editionsData = json?.data?.searchEditions?.data?.searchSummary?.data
        // Log first response structure for debugging
        if (result.size === 0 && editionsData) {
          console.log("[wallet-enrich-flowty] TS GQL response shape for " + ed.editionKey + ": " + JSON.stringify(editionsData).slice(0, 300))
        }
        const editionArr = Array.isArray(editionsData) ? editionsData : editionsData?.data
        const edition = Array.isArray(editionArr) ? editionArr[0] : null
        if (!edition) return
        const lowestAsk = edition.lowestAsk != null ? parseFloat(String(edition.lowestAsk)) : null
        result.set(ed.editionKey, {
          editionKey: ed.editionKey,
          setID: ed.setID,
          playID: ed.playID,
          lowestAsk: lowestAsk && lowestAsk > 0 ? lowestAsk : null,
          circulationCount: edition.circulationCount ?? null,
        })
      } catch (err) {
        if (i === 0) console.log("[wallet-enrich-flowty] TS GQL exception for " + ed.editionKey + ": " + (err instanceof Error ? err.message : String(err)))
      }
    })
    await Promise.all(promises)
  }
  return result
}

// Flowty: fetch cheapest listings to get floor prices and LiveToken FMV
// Returns a map of editionKey → { flowtyAsk, livetokenFmv }
type FlowtyData = { flowtyAsk: number | null; livetokenFmv: number | null }

function flattenTraits(raw: unknown): Array<{ name: string; value: string }> {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  const inner = (raw as Record<string, unknown>).traits ?? raw
  if (Array.isArray(inner)) return inner
  return Object.values(inner as Record<string, unknown>)
    .filter((v): v is { name: string; value: string } =>
      typeof v === "object" && v !== null && "name" in v)
}

function getTraitValue(traits: Array<{ name: string; value: string }>, keys: string[]): string {
  for (const key of keys) {
    const found = traits.find(function (t) { return t.name === key })
    if (found?.value) return found.value
  }
  return ""
}

async function fetchFlowtyData(targetEditionKeys: Set<string>): Promise<Map<string, FlowtyData>> {
  const result = new Map<string, FlowtyData>()
  // Fetch several pages of cheapest listings sorted by price
  const PAGES = [0, 48, 96, 144, 192]
  for (const from of PAGES) {
    try {
      const res = await fetch(FLOWTY_ENDPOINT, {
        method: "POST",
        headers: FLOWTY_HEADERS,
        body: JSON.stringify({
          address: null,
          addresses: [],
          collectionFilters: [{ collection: "0x0b2a3299cc857e29.TopShot", traits: [] }],
          from,
          includeAllListings: true,
          limit: 48,
          onlyUnlisted: false,
          orderFilters: [{ conditions: [], kind: "storefront", paymentTokens: [] }],
          sort: { direction: "asc", listingKind: "storefront", path: "salePrice" },
        }),
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) continue
      const json = await res.json()
      const nfts = json?.nfts ?? []

      for (const nft of nfts) {
        const traits = flattenTraits(nft.nftView?.traits)
        const setID = getTraitValue(traits, ["SetID", "setID", "setId"])
        const playID = getTraitValue(traits, ["PlayID", "playID", "playId"])
        if (!setID || !playID) continue
        const editionKey = setID + ":" + playID
        if (!targetEditionKeys.has(editionKey)) continue
        if (result.has(editionKey)) continue // already got cheapest

        const order = nft.orders?.find(function (o: any) { return o.salePrice > 0 })
        const flowtyAsk = order?.salePrice ?? null
        const livetokenFmv = nft.valuations?.blended?.usdValue ?? nft.valuations?.livetoken?.usdValue ?? null

        result.set(editionKey, {
          flowtyAsk: flowtyAsk && flowtyAsk > 0 ? flowtyAsk : null,
          livetokenFmv: livetokenFmv && livetokenFmv > 0 ? livetokenFmv : null,
        })
      }
    } catch { /* page failed — continue */ }
  }
  return result
}

export async function POST(req: NextRequest) {
  const startTime = Date.now()

  let wallet: string
  try {
    const body = await req.json()
    wallet = (body.wallet as string)?.trim()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  if (!wallet) {
    return NextResponse.json({ error: "wallet required" }, { status: 400 })
  }

  // Step 1: Get all unique edition_keys for this wallet
  const { data: cacheRows, error: cacheErr } = await (supabaseAdmin as any)
    .from("wallet_moments_cache")
    .select("edition_key")
    .eq("wallet_address", wallet)
    .not("edition_key", "is", null)

  if (cacheErr || !cacheRows?.length) {
    return NextResponse.json({ ok: true, enriched: 0, reason: "no editions" })
  }

  const keySet = new Set<string>()
  for (const r of cacheRows) { keySet.add((r as any).edition_key as string) }
  const uniqueKeys = Array.from(keySet)
  console.log("[wallet-enrich-flowty] wallet=" + wallet + " unique_editions=" + uniqueKeys.length)

  // Parse edition keys into setID:playID pairs
  const editionPairs = uniqueKeys
    .map(function (ek) {
      const parts = ek.split(":")
      if (parts.length !== 2) return null
      return { editionKey: ek, setID: parts[0], playID: parts[1] }
    })
    .filter(Boolean) as { editionKey: string; setID: string; playID: string }[]

  // Step 2: Resolve editions to internal UUIDs (integer-format edition)
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
  console.log("[wallet-enrich-flowty] edition_uuid_resolved=" + editionUuidMap.size + "/" + uniqueKeys.length)

  // Step 3: Fetch Top Shot asks (up to 200 editions to stay within timeout)
  const editionsToEnrich = editionPairs.slice(0, 200)
  const targetKeySet = new Set(editionsToEnrich.map(function (e) { return e.editionKey }))

  const [tsAsks, flowtyData] = await Promise.all([
    fetchTopShotAsks(editionsToEnrich),
    fetchFlowtyData(targetKeySet),
  ])

  // Detailed logging for debugging
  let tsWithAsk = 0
  let tsNoAsk = 0
  for (const v of tsAsks.values()) { if (v.lowestAsk) tsWithAsk++; else tsNoAsk++ }
  console.log("[wallet-enrich-flowty] ts_gql_responded=" + tsAsks.size + " ts_with_ask=" + tsWithAsk + " ts_no_ask=" + tsNoAsk + " flowty_matched=" + flowtyData.size)

  // Step 4: Build fmv_snapshots rows — write a row for EVERY edition that got
  // any market signal (lowestAsk, flowtyAsk, or livetokenFmv)
  let enriched = 0
  let skippedNoUuid = 0
  let skippedNoData = 0
  const upsertRows: Record<string, unknown>[] = []

  for (const ed of editionsToEnrich) {
    const ts = tsAsks.get(ed.editionKey)
    const fl = flowtyData.get(ed.editionKey)
    const edUuid = editionUuidMap.get(ed.editionKey)

    if (!edUuid) { skippedNoUuid++; continue }

    const topShotAsk = ts?.lowestAsk ?? null
    const flowtyAsk = fl?.flowtyAsk ?? null
    const livetokenFmv = fl?.livetokenFmv ?? null
    const crossMarketAsk = topShotAsk !== null && flowtyAsk !== null
      ? Math.min(topShotAsk, flowtyAsk)
      : topShotAsk ?? flowtyAsk

    // Skip only if we have absolutely nothing
    if (!topShotAsk && !flowtyAsk && !livetokenFmv) { skippedNoData++; continue }

    // FMV priority: LiveToken FMV > 90% of lowest ask
    const fmvUsd = livetokenFmv ?? (crossMarketAsk ? Number((crossMarketAsk * 0.9).toFixed(2)) : null)

    // Use ASK_ONLY confidence when we have asks but no sales
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

  console.log("[wallet-enrich-flowty] rows_to_write=" + upsertRows.length + " skipped_no_uuid=" + skippedNoUuid + " skipped_no_data=" + skippedNoData)

  // Step 5: Delete old flowty-live snapshots then insert fresh ones
  let insertSucceeded = 0
  let insertErrors: string[] = []

  if (upsertRows.length > 0) {
    const editionIds = upsertRows.map(function (r) { return r.edition_id as string })

    // Delete old flowty-live rows only
    const { error: delErr } = await (supabaseAdmin as any)
      .from("fmv_snapshots")
      .delete()
      .in("edition_id", editionIds)
      .eq("algo_version", "flowty-live")
    if (delErr) console.log("[wallet-enrich-flowty] delete error:", delErr.message)

    // Insert in chunks
    for (let i = 0; i < upsertRows.length; i += CHUNK) {
      const chunk = upsertRows.slice(i, i + CHUNK)
      const { data: inserted, error: insertErr } = await (supabaseAdmin as any)
        .from("fmv_snapshots")
        .insert(chunk)
        .select("id")
      if (insertErr) {
        insertErrors.push(insertErr.message)
        console.log("[wallet-enrich-flowty] insert error chunk " + Math.floor(i / CHUNK) + ": " + insertErr.message)
        // Log first failing row for debugging
        if (chunk.length > 0) {
          console.log("[wallet-enrich-flowty] sample failing row: " + JSON.stringify(chunk[0]))
        }
      } else {
        insertSucceeded += inserted?.length ?? chunk.length
      }
    }
  }

  const duration = Date.now() - startTime
  console.log("[wallet-enrich-flowty] DONE: enriched=" + enriched + " inserted=" + insertSucceeded + " errors=" + insertErrors.length + " duration=" + duration + "ms")

  return NextResponse.json({
    ok: true,
    wallet,
    editions_checked: editionsToEnrich.length,
    edition_uuids_found: editionUuidMap.size,
    ts_asks_found: tsWithAsk,
    flowty_data_found: flowtyData.size,
    rows_built: upsertRows.length,
    rows_inserted: insertSucceeded,
    insert_errors: insertErrors.slice(0, 3),
    skipped_no_uuid: skippedNoUuid,
    skipped_no_data: skippedNoData,
    duration_ms: duration,
  })
}
