import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

/**
 * POST /api/wallet-enrich-flowty
 *
 * For each unique edition in a wallet, fetches live Low Ask from Top Shot GQL
 * (searchMintedMoments sorted by price) and LiveToken FMV + Flowty floor from
 * the Flowty collection API. Writes results as fmv_snapshots with algo_version
 * 'flowty-live' so the collection page shows real prices.
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
  Origin: "https://www.flowty.io",
  Referer: "https://www.flowty.io/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36",
}

// ── BUG 1 FIX: Resolve username → Flow address ─────────────────────────────

async function resolveToFlowAddress(input: string): Promise<string | null> {
  const trimmed = input.trim()
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return trimmed

  // Username → Flow address via Top Shot GQL
  const cleanedUsername = trimmed.replace(/^@+/, "")
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
        variables: { username: cleanedUsername },
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

// ── BUG 2 FIX: Correct GQL query for edition lowest ask ────────────────────

const SEARCH_MINTED_MOMENTS_QUERY = `
  query SearchLowestAsk($setID: String!, $playID: String!) {
    searchMintedMoments(input: {
      filters: {
        byEdition: { setID: $setID, playID: $playID }
      }
      sortBy: PRICE_USD_ASC
      searchInput: { pagination: { cursor: "", direction: RIGHT, limit: 1 } }
    }) {
      data {
        searchSummary {
          data {
            ... on MintedMoments {
              data {
                ... on MintedMoment {
                  price
                  listingOrderID
                }
              }
            }
          }
        }
      }
    }
  }
`

type TsAskResult = { editionKey: string; lowestAsk: number | null }

async function fetchTopShotAsks(
  editions: { editionKey: string; setID: string; playID: string }[]
): Promise<Map<string, TsAskResult>> {
  const result = new Map<string, TsAskResult>()
  const CONCURRENCY = 8
  let gqlErrors = 0
  let gqlOk = 0

  for (let i = 0; i < editions.length; i += CONCURRENCY) {
    const batch = editions.slice(i, i + CONCURRENCY)
    const promises = batch.map(async function (ed) {
      try {
        const res = await fetch(TOPSHOT_GQL, {
          method: "POST",
          headers: GQL_HEADERS,
          body: JSON.stringify({
            query: SEARCH_MINTED_MOMENTS_QUERY,
            variables: { setID: ed.setID, playID: ed.playID },
          }),
          signal: AbortSignal.timeout(8000),
        })
        if (!res.ok) { gqlErrors++; return }
        const json = await res.json()
        if (json.errors?.length) { gqlErrors++; return }

        // Log first response for debugging
        if (result.size === 0) {
          const summary = json?.data?.searchMintedMoments?.data?.searchSummary
          console.log("[wallet-enrich] TS GQL first response for " + ed.editionKey + ": " + JSON.stringify(summary).slice(0, 400))
        }

        const summaryData = json?.data?.searchMintedMoments?.data?.searchSummary?.data
        // Handle both array and nested .data shapes
        const momentArr = Array.isArray(summaryData) ? summaryData : summaryData?.data
        const moment = Array.isArray(momentArr) ? momentArr[0] : null
        const price = moment?.price != null ? parseFloat(String(moment.price)) : null
        gqlOk++
        result.set(ed.editionKey, {
          editionKey: ed.editionKey,
          lowestAsk: price && price > 0 ? price : null,
        })
      } catch { gqlErrors++ }
    })
    await Promise.all(promises)
  }

  console.log("[wallet-enrich] TS GQL: ok=" + gqlOk + " errors=" + gqlErrors + " with_ask=" + Array.from(result.values()).filter(function (v) { return v.lowestAsk !== null }).length)
  return result
}

// ── BUG 3 FIX: Flowty bulk fetch + match by nft traits ─────────────────────

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
  const PAGES = [0, 48, 96, 144, 192]
  let totalNfts = 0
  let matched = 0

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
      if (!res.ok) {
        console.log("[wallet-enrich] Flowty HTTP " + res.status + " from=" + from)
        continue
      }
      const json = await res.json()
      const nfts = json?.nfts ?? []
      totalNfts += nfts.length

      // Log first page structure for debugging
      if (from === 0 && nfts.length > 0) {
        const first = nfts[0]
        const traits = flattenTraits(first.nftView?.traits)
        const traitNames = traits.map(function (t: { name: string }) { return t.name }).join(", ")
        console.log("[wallet-enrich] Flowty first nft trait keys: " + traitNames)
        console.log("[wallet-enrich] Flowty first nft card: " + JSON.stringify(first.card ?? {}).slice(0, 200))
        console.log("[wallet-enrich] Flowty first nft valuations: " + JSON.stringify(first.valuations ?? {}).slice(0, 200))
      }

      for (const nft of nfts) {
        // Try multiple paths to find setID and playID
        const traits = flattenTraits(nft.nftView?.traits)
        const setID = getTraitValue(traits, ["SetID", "setID", "setId", "Set ID"])
          || (nft.card?.setID ? String(nft.card.setID) : "")
        const playID = getTraitValue(traits, ["PlayID", "playID", "playId", "Play ID"])
          || (nft.card?.playID ? String(nft.card.playID) : "")

        if (!setID || !playID) continue
        const editionKey = setID + ":" + playID
        if (!targetEditionKeys.has(editionKey)) continue
        if (result.has(editionKey)) continue // already got cheapest for this edition

        const order = (nft.orders ?? []).find(function (o: any) { return o.salePrice > 0 })
        const flowtyAsk = order?.salePrice ?? null
        const livetokenFmv = nft.valuations?.blended?.usdValue ?? nft.valuations?.livetoken?.usdValue ?? null

        result.set(editionKey, {
          flowtyAsk: flowtyAsk && flowtyAsk > 0 ? flowtyAsk : null,
          livetokenFmv: livetokenFmv && livetokenFmv > 0 ? livetokenFmv : null,
        })
        matched++
      }
    } catch (err) {
      console.log("[wallet-enrich] Flowty from=" + from + " error: " + (err instanceof Error ? err.message : String(err)))
    }
  }

  console.log("[wallet-enrich] Flowty: total_nfts=" + totalNfts + " matched_editions=" + matched)
  return result
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

  // BUG 1 FIX: resolve username to Flow address
  const wallet = await resolveToFlowAddress(walletInput)
  if (!wallet) {
    return NextResponse.json({ error: "Could not resolve wallet: " + walletInput }, { status: 400 })
  }
  console.log("[wallet-enrich] input=" + walletInput + " resolved=" + wallet)

  // Step 1: Get all unique edition_keys for this wallet
  const { data: cacheRows, error: cacheErr } = await (supabaseAdmin as any)
    .from("wallet_moments_cache")
    .select("edition_key")
    .eq("wallet_address", wallet)
    .not("edition_key", "is", null)

  if (cacheErr || !cacheRows?.length) {
    const diag = { ok: true, enriched: 0, reason: "no editions", wallet, input: walletInput, cache_rows: cacheRows?.length ?? 0 }
    await (supabaseAdmin as any).from("debug_logs").insert({ route: "wallet-enrich-flowty", payload: diag }).catch(function () {})
    return NextResponse.json(diag)
  }

  const keySet = new Set<string>()
  for (const r of cacheRows) { keySet.add((r as any).edition_key as string) }
  const uniqueKeys = Array.from(keySet)
  console.log("[wallet-enrich] wallet=" + wallet + " unique_editions=" + uniqueKeys.length)

  // Parse edition keys into setID:playID pairs
  const editionPairs = uniqueKeys
    .map(function (ek) {
      const parts = ek.split(":")
      if (parts.length !== 2) return null
      return { editionKey: ek, setID: parts[0], playID: parts[1] }
    })
    .filter(Boolean) as { editionKey: string; setID: string; playID: string }[]

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

  // Step 3: Fetch Top Shot asks + Flowty data in parallel (up to 200 editions)
  const editionsToEnrich = editionPairs.slice(0, 200)
  const targetKeySet = new Set(editionsToEnrich.map(function (e) { return e.editionKey }))

  const [tsAsks, flowtyData] = await Promise.all([
    fetchTopShotAsks(editionsToEnrich),
    fetchFlowtyData(targetKeySet),
  ])

  let tsWithAsk = 0
  for (const v of tsAsks.values()) { if (v.lowestAsk) tsWithAsk++ }

  // Step 4: Build fmv_snapshots rows
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
        if (chunk.length > 0) {
          console.log("[wallet-enrich] sample row: " + JSON.stringify(chunk[0]))
        }
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
    editions_checked: editionsToEnrich.length,
    edition_uuids_found: editionUuidMap.size,
    ts_gql_responded: tsAsks.size,
    ts_asks_found: tsWithAsk,
    flowty_data_found: flowtyData.size,
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
