import { NextRequest, NextResponse } from "next/server"
import fcl from "@/lib/flow"
import * as t from "@onflow/types"
import { createClient } from "@supabase/supabase-js"
import { getCollection } from "@/lib/collections"

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ── Collection-specific Cadence scripts ──────────────────────────────────────

const TOPSHOT_GET_IDS = `
  import TopShot from 0x0b2a3299cc857e29
  access(all)
  fun main(address: Address): [UInt64] {
    let acct = getAccount(address)
    let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
    if col == nil { return [] }
    return col!.getIDs()
  }
`

const ALLDAY_GET_IDS = `
  import AllDay from 0xe4cf4bdc1751c65d
  access(all)
  fun main(address: Address): [UInt64] {
    let acct = getAccount(address)
    let col = acct.capabilities.borrow<&{AllDay.MomentNFTCollectionPublic}>(/public/AllDayMomentNFTCollection)
    if col == nil { return [] }
    return col!.getIDs()
  }
`

const TOPSHOT_GET_METADATA = `
  import TopShot from 0x0b2a3299cc857e29
  import MetadataViews from 0x1d7e57aa55817448
  access(all)
  fun main(address: Address, id: UInt64): {String:String} {
    let acct = getAccount(address)
    let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
      ?? panic("no collection")
    let nft = col.borrowMoment(id:id) ?? panic("no nft")

    let setID = nft.data.setID.toString()
    let playID = nft.data.playID.toString()
    let serial = nft.data.serialNumber.toString()

    if let view = nft.resolveView(Type<TopShot.TopShotMomentMetadataView>()) {
      let data = view as! TopShot.TopShotMomentMetadataView
      return {
        "player": data.fullName ?? "",
        "team": data.teamAtMoment ?? "",
        "setName": data.setName ?? "",
        "series": data.seriesNumber?.toString() ?? "",
        "serial": serial,
        "mint": data.numMomentsInEdition?.toString() ?? "",
        "playID": playID,
        "setID": setID,
        "tier": data.momentTierString ?? ""
      }
    }

    var displayName = ""
    if let display = nft.resolveView(Type<MetadataViews.Display>()) as? MetadataViews.Display {
      displayName = display.name
    }

    return {
      "player": displayName,
      "team": "",
      "setName": "",
      "series": "",
      "serial": serial,
      "mint": "",
      "playID": playID,
      "setID": setID,
      "tier": ""
    }
  }
`

const ALLDAY_GET_METADATA = `
  import AllDay from 0xe4cf4bdc1751c65d
  import MetadataViews from 0x1d7e57aa55817448
  access(all)
  fun main(address: Address, id: UInt64): {String:String} {
    let acct = getAccount(address)
    let col = acct.capabilities.borrow<&{AllDay.MomentNFTCollectionPublic}>(/public/AllDayMomentNFTCollection)
      ?? panic("no collection")
    let nft = col.borrowMomentNFT(id: id) ?? panic("no nft")
    let editionID = nft.editionID.toString()
    let serial = nft.serialNumber.toString()

    if let display = nft.resolveView(Type<MetadataViews.Display>()) as? MetadataViews.Display {
      return {
        "player": display.name,
        "team": "",
        "setName": "",
        "series": "",
        "serial": serial,
        "mint": "",
        "playID": editionID,
        "setID": editionID,
        "tier": ""
      }
    }

    return {
      "player": "",
      "team": "",
      "setName": "",
      "series": "",
      "serial": serial,
      "mint": "",
      "playID": editionID,
      "setID": editionID,
      "tier": ""
    }
  }
`

type CollectionScripts = {
  getIds: string
  getMetadata: string
  collectionId: string
  buildEditionKey: (meta: Record<string, string>) => string
}

const COLLECTION_SCRIPTS: Record<string, CollectionScripts> = {
  "nba-top-shot": {
    getIds: TOPSHOT_GET_IDS,
    getMetadata: TOPSHOT_GET_METADATA,
    collectionId: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
    buildEditionKey: function(meta) { return meta.setID + ":" + meta.playID },
  },
  "nfl-all-day": {
    getIds: ALLDAY_GET_IDS,
    getMetadata: ALLDAY_GET_METADATA,
    collectionId: "dee28451-5d62-409e-a1ad-a83f763ac070",
    buildEditionKey: function(meta) { return meta.playID || meta.setID },
  },
}

// ── Concurrency helper ──────────────────────────────────────────────────────

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex++
      if (currentIndex >= items.length) return
      results[currentIndex] = await worker(items[currentIndex], currentIndex)
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => runWorker())
  )
  return results
}

// ── GQL helper for moment enrichment (isLocked + metadata) ─────────────────

const TOPSHOT_GQL_URL = "https://public-api.nbatopshot.com/graphql"

const GQL_GET_MOMENT = `
  query GetMomentEnrich($id: ID!) {
    getMintedMoment(momentId: $id) {
      data {
        flowId
        flowSerialNumber
        tier
        isLocked
      }
    }
  }
`

type GqlMomentData = {
  flowId?: string | null
  flowSerialNumber?: number | null
  tier?: string | null
  isLocked?: boolean | null
}

async function fetchMomentGql(momentId: string): Promise<GqlMomentData | null> {
  try {
    const res = await fetch(TOPSHOT_GQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "sports-collectible-tool/0.1" },
      body: JSON.stringify({ query: GQL_GET_MOMENT, variables: { id: momentId } }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      console.log("[cache-refresh] GQL HTTP " + res.status + " for moment " + momentId)
      return null
    }
    const json = await res.json()
    const data = json?.data?.getMintedMoment?.data as GqlMomentData | undefined
    if (!data) {
      console.log("[cache-refresh] GQL returned no data for moment " + momentId)
      return null
    }
    return data
  } catch (e: any) {
    console.log("[cache-refresh] GQL error for moment " + momentId + ": " + (e.message || "unknown"))
    return null
  }
}

// ── Route handler ───────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  try {
    const sp = req.nextUrl.searchParams
    const wallet = sp.get("wallet")?.trim()
    if (!wallet || !wallet.startsWith("0x")) {
      return NextResponse.json({ error: "wallet param required (0x...)" }, { status: 400 })
    }

    // Auth: either INGEST_SECRET_TOKEN or no auth required (public for own-wallet refresh)
    // The route is lightweight and read-mostly, so we allow unauthenticated calls
    // but cap enrichment to 50 moments per call to prevent abuse.

    const collectionSlug = sp.get("collection")?.trim() || "nba-top-shot"
    const scripts = COLLECTION_SCRIPTS[collectionSlug]
    if (!scripts) {
      return NextResponse.json({ error: "Unsupported collection: " + collectionSlug }, { status: 400 })
    }

    const collectionId = scripts.collectionId

    // Step 1: Get on-chain moment IDs
    let onChainIds: string[]
    try {
      const result = await fcl.query({
        cadence: scripts.getIds,
        args: (arg: any) => [arg(wallet, t.Address)],
      })
      onChainIds = Array.isArray(result) ? result.map(String) : []
    } catch (e: any) {
      console.log("[cache-refresh] FCL getIDs error: " + (e.message || "unknown"))
      return NextResponse.json({ error: "Failed to query on-chain IDs" }, { status: 502 })
    }

    if (onChainIds.length === 0) {
      return NextResponse.json({
        ok: true, total_on_chain: 0, total_cached: 0,
        new_stubs_inserted: 0, enriched: 0, removed_count: 0,
        elapsed: Date.now() - startTime,
      })
    }

    // Step 2: Get cached moment IDs
    const cachedIds = new Set<string>()
    for (let i = 0; i < onChainIds.length; i += 500) {
      const chunk = onChainIds.slice(i, i + 500)
      const { data } = await supabase
        .from("wallet_moments_cache")
        .select("moment_id")
        .eq("wallet_address", wallet)
        .eq("collection_id", collectionId)
        .in("moment_id", chunk)
      for (const row of data ?? []) {
        if (row.moment_id) cachedIds.add(String(row.moment_id))
      }
    }

    // Step 3: Diff — new IDs not in cache
    const newIds = onChainIds.filter(function(id) { return !cachedIds.has(id) })
    // IDs in cache but not on-chain (sold/burned)
    // We need all cached IDs for this, not just the ones we queried
    let removedCount = 0
    if (cachedIds.size > 0) {
      const onChainSet = new Set(onChainIds)
      for (const id of cachedIds) {
        if (!onChainSet.has(id)) removedCount++
      }
    }

    console.log("[cache-refresh] wallet=" + wallet + " collection=" + collectionSlug +
      " onChain=" + onChainIds.length + " cached=" + cachedIds.size +
      " new=" + newIds.length + " removed=" + removedCount)

    if (newIds.length === 0) {
      return NextResponse.json({
        ok: true, total_on_chain: onChainIds.length, total_cached: cachedIds.size,
        new_stubs_inserted: 0, enriched: 0, removed_count: removedCount,
        elapsed: Date.now() - startTime,
      })
    }

    // Step 4: Insert stub rows for new moments
    const now = new Date().toISOString()
    let stubsInserted = 0
    for (let i = 0; i < newIds.length; i += 200) {
      const chunk = newIds.slice(i, i + 200)
      const rows = chunk.map(function(id) {
        return {
          moment_id: id,
          wallet_address: wallet,
          collection_id: collectionId,
          last_seen_at: now,
        }
      })
      const { error } = await supabase
        .from("wallet_moments_cache")
        .upsert(rows, { onConflict: "wallet_address,moment_id" })
      if (error) {
        console.log("[cache-refresh] stub insert error: " + error.message)
      } else {
        stubsInserted += chunk.length
      }
    }

    // Step 5: Insert moment_acquisitions rows for new IDs (unknown method)
    // Only insert for nft_ids that don't already have ANY acquisition row for this wallet,
    // to avoid creating duplicate rows that override real marketplace data.
    const existingAcqIds = new Set<string>()
    for (let i = 0; i < newIds.length; i += 500) {
      const chunk = newIds.slice(i, i + 500)
      const { data: existingRows } = await supabase
        .from("moment_acquisitions")
        .select("nft_id")
        .eq("wallet", wallet)
        .in("nft_id", chunk)
      for (const row of existingRows ?? []) {
        if (row.nft_id) existingAcqIds.add(String(row.nft_id))
      }
    }
    const acqNewIds = newIds.filter(function(id) { return !existingAcqIds.has(id) })

    for (let i = 0; i < acqNewIds.length; i += 200) {
      const chunk = acqNewIds.slice(i, i + 200)
      const rows = chunk.map(function(id) {
        return {
          nft_id: id,
          wallet: wallet,
          acquisition_method: "unknown",
          acquired_date: now,
          acquired_type: 1,
          transaction_hash: "cache-refresh:" + id,
          source: "cache_refresh",
        }
      })
      const { error } = await supabase
        .from("moment_acquisitions")
        .insert(rows)
      if (error) {
        console.log("[cache-refresh] acquisitions insert error: " + error.message)
      }
    }

    // Step 6: Enrich stubs with on-chain metadata (up to 50 to avoid timeout)
    const toEnrich = newIds.slice(0, 50)
    let enriched = 0
    if (toEnrich.length > 0) {
      const isTopShot = collectionSlug === "nba-top-shot"
      const results = await mapWithConcurrency(toEnrich, 8, async function(id) {
        try {
          const [meta, gql] = await Promise.all([
            fcl.query({
              cadence: scripts.getMetadata,
              args: (arg: any) => [arg(wallet, t.Address), arg(id, t.UInt64)],
            }) as Promise<Record<string, string>>,
            isTopShot ? fetchMomentGql(id) : Promise.resolve(null),
          ])
          return { id, meta, gql }
        } catch (e: any) {
          console.log("[cache-refresh] metadata error for " + id + ": " + (e.message || "unknown"))
          return { id, meta: null, gql: null }
        }
      })

      let lockedCount = 0
      for (const { id, meta, gql } of results) {
        if (!meta) continue
        const editionKey = scripts.buildEditionKey(meta)
        const seriesNum = meta.series ? parseInt(meta.series, 10) : null
        const isLocked = gql?.isLocked === true
        if (isLocked) lockedCount++
        const update: Record<string, any> = {
          player_name: meta.player || null,
          set_name: meta.setName || null,
          edition_key: editionKey || null,
          serial_number: meta.serial ? parseInt(meta.serial, 10) : null,
          is_locked: isLocked,
        }
        if (seriesNum !== null && !isNaN(seriesNum)) update.series_number = seriesNum
        if (meta.tier || gql?.tier) update.tier = meta.tier || gql?.tier

        const { error } = await supabase
          .from("wallet_moments_cache")
          .update(update)
          .eq("wallet_address", wallet)
          .eq("moment_id", id)
        if (!error) enriched++
      }
      console.log("[cache-refresh] isLocked: " + lockedCount + "/" + results.length + " moments locked")
    }

    console.log("[cache-refresh] Done: stubs=" + stubsInserted + " enriched=" + enriched +
      " elapsed=" + (Date.now() - startTime) + "ms")

    return NextResponse.json({
      ok: true,
      total_on_chain: onChainIds.length,
      total_cached: cachedIds.size + stubsInserted,
      new_stubs_inserted: stubsInserted,
      enriched,
      removed_count: removedCount,
      elapsed: Date.now() - startTime,
    })
  } catch (e: any) {
    console.error("[cache-refresh] FATAL:", e.message || "unknown", e.stack || "")
    return NextResponse.json({ ok: false, error: e.message || "Unknown error" }, { status: 500 })
  }
}
