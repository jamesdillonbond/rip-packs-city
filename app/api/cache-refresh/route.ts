import { NextRequest, NextResponse } from "next/server"
import fcl from "@/lib/chains/flow/flow"
import * as t from "@onflow/types"
import { createClient } from "@supabase/supabase-js"
import { getCollection } from "@/lib/collections"

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ── Refresh cooldown (R98, 2026-09-18) ───────────────────────────────────────
// This route is public on purpose (own-wallet refresh needs no token) and the
// Collection tab calls it for the VIEWED wallet on load — so any visitor viewing
// a 44k-moment wallet drove a full pass every time: an FCL getIDs, a rewrite of
// `last_seen_at` on EVERY cached row (that touch is by design — it feeds the
// "Last updated" stamp), stub upserts and acquisition inserts, all as
// service_role. Nothing bounded how often. The bound is a per-(wallet, collection)
// COOLDOWN read off the data the route itself writes: if the newest
// `last_seen_at` for that wallet is younger than the window, the call returns
// `skipped: "recently_refreshed"` with the timestamp and does no chain read and
// no write. The manual refresh button (`refreshLocked=1`) keeps a short window
// (double-click protection); an INGEST bearer bypasses it entirely. ⚠ If the
// cooldown READ fails the route refreshes as before — the bound fails toward the
// product working, and it logs that it did; it never turns a failed read into a
// fabricated "recently refreshed".
const AUTO_REFRESH_COOLDOWN_MS = 10 * 60 * 1000
const MANUAL_REFRESH_COOLDOWN_MS = 60 * 1000

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
    if (!wallet) {
      return NextResponse.json({ error: "wallet param required" }, { status: 400 })
    }

    // Auth: either INGEST_SECRET_TOKEN or no auth required (public for own-wallet refresh)
    // The route is lightweight and read-mostly, so we allow unauthenticated calls
    // but cap enrichment to 50 moments per call to prevent abuse.

    // ⛔ 2026-09-19 — THE COLLECTION CHECK NOW RUNS FIRST, AND THE ORDER IS THE
    // WHOLE FIX. Both guards were real, but they were sequenced so the wrong one
    // spoke: a Candy MLB wallet (Solana base58) failed the `0x` test and got
    // **`"wallet param required (0x...)"`**, which is false twice over — the
    // param was present, and this route could not have served `candy-mlb`
    // whatever address you passed it.
    //
    // ⭐ THIS ROUTE IS CADENCE-SCRIPT-DRIVEN BY CONSTRUCTION, and the honest
    // diagnosis is the collection, not the address: COLLECTION_SCRIPTS holds
    // exactly TWO entries (nba-top-shot, nfl-all-day), so Golazos, Pinnacle and
    // UFC have always been "Unsupported collection" here too. Candy is not a
    // special case; it is the fourth member of an existing set, and the answer
    // it should get is the one those three already get.
    //
    // ⚠ NOT "ADD CANDY SUPPORT" — the Candy equivalent ALREADY EXISTS as
    // `app/api/wallet-backfill-candy`, which reads Metaplex Core via DAS and
    // upserts the same `wallet_moments_cache` rows. Teaching a Cadence-script
    // route to speak Solana would duplicate a working lane. Grep before you
    // build; the thing was already there.
    const collectionSlug = sp.get("collection")?.trim() || "nba-top-shot"
    const scripts = COLLECTION_SCRIPTS[collectionSlug]
    if (!scripts) {
      return NextResponse.json(
        {
          error: "Unsupported collection: " + collectionSlug,
          supported: Object.keys(COLLECTION_SCRIPTS),
        },
        { status: 400 }
      )
    }

    // Shape check AFTER the collection is known to be one this route serves, so
    // the message is about the address and nothing else. Separated from the
    // missing-param case above: "absent" and "present but not a Flow address"
    // are different states and were previously collapsed into one string.
    if (!wallet.startsWith("0x")) {
      return NextResponse.json(
        { error: "wallet must be a Flow address (0x...) for " + collectionSlug },
        { status: 400 }
      )
    }

    const collectionId = scripts.collectionId

    // ── Cooldown (R98): bound the per-(wallet, collection) refresh rate ──────
    const auth = req.headers.get("authorization") ?? ""
    const ingest = process.env.INGEST_SECRET_TOKEN
    const trustedCaller = !!ingest && auth === `Bearer ${ingest}`
    const manualRefresh = sp.get("refreshLocked") === "1"
    const cooldownMs = manualRefresh ? MANUAL_REFRESH_COOLDOWN_MS : AUTO_REFRESH_COOLDOWN_MS
    if (!trustedCaller) {
      const { data: recent, error: recentErr } = await supabase
        .from("wallet_moments_cache")
        .select("last_seen_at")
        .eq("wallet_address", wallet)
        .eq("collection_id", collectionId)
        .order("last_seen_at", { ascending: false })
        .limit(1)
      if (recentErr) {
        // A failed read is not "recently refreshed" — refresh as before, and say why.
        console.log("[cache-refresh] cooldown read failed, refreshing anyway: " + recentErr.message)
      } else {
        const lastRaw = Array.isArray(recent) ? recent[0]?.last_seen_at : undefined
        const lastMs = typeof lastRaw === "string" ? Date.parse(lastRaw) : NaN
        const ageMs = Date.now() - lastMs
        if (Number.isFinite(lastMs) && ageMs >= 0 && ageMs < cooldownMs) {
          return NextResponse.json({
            ok: true,
            skipped: "recently_refreshed",
            last_refreshed_at: lastRaw,
            retry_after_seconds: Math.max(1, Math.ceil((cooldownMs - ageMs) / 1000)),
            // Not measured on a skipped call — null, never a fabricated 0.
            total_on_chain: null, total_cached: null,
            new_stubs_inserted: 0, enriched: 0, removed_count: 0, last_seen_touched: 0,
            elapsed: Date.now() - startTime,
          })
        }
      }
    }

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

    // ⛔ `removed_count` IS STRUCTURALLY ALWAYS ZERO, AND THAT IS NOT A BUG TO "FIX" HERE — it is
    // a field that must stop pretending to be a measurement. Removed 2026-09-19 (Cowork cloud).
    //
    // The old code diffed `cachedIds` against `new Set(onChainIds)` and counted the misses as
    // "sold/burned". But `cachedIds` is built two blocks up ENTIRELY from rows matching
    // `.in("moment_id", chunk)` where every chunk is a slice of `onChainIds` — so
    // `cachedIds ⊆ onChainIds` BY CONSTRUCTION and the miss branch was unreachable. The loop ran
    // over every cached id on every refresh to compute a constant.
    //
    // ⭐ The gap was NAMED IN PLACE and never closed: the deleted lines carried the comment
    // "We need all cached IDs for this, not just the ones we queried". A comment that states a
    // precondition the code does not meet is not a caveat, it is an unclosed bug with an alibi.
    //
    // WHO ACTUALLY REMOVES SOLD/BURNED MOMENTS (verified live 2026-09-19, so nobody re-derives it):
    //   · `upsert_wallet_moments(wallet, collection, moments)` — the FULL-SET writer; it deletes
    //     rows not present in the supplied set. This is the authoritative reconcile.
    //   · `prune_stale_wmc()` — pg_cron jobid 199, weekly, Sundays.
    //   · `purge_candy_wmc_ghost_rows()` — pg_cron jobid 201, daily.
    // This route is the INCREMENTAL stub path. It inserts and enriches; it has never deleted, and
    // `grep -n '\.delete('` over this file returns nothing. The key is kept at a literal 0 rather
    // than dropped so the response shape is unchanged (it has no reader in this repo — checked),
    // and so that a future reader meets this note instead of the loop.
    const removedCount = 0

    console.log("[cache-refresh] wallet=" + wallet + " collection=" + collectionSlug +
      " onChain=" + onChainIds.length + " cached=" + cachedIds.size +
      " new=" + newIds.length + " removed=" + removedCount)

    // Bump last_seen_at for every cached row whose moment is still on-chain.
    // Without this, a refresh cycle on a wallet with no new moments would
    // leave last_seen_at frozen at the original seed date, making the
    // collection page show stale "Last updated N days ago" timestamps.
    const touchedAt = new Date().toISOString()
    let lastSeenTouched = 0
    if (cachedIds.size > 0) {
      const cachedIdArr = Array.from(cachedIds)
      for (let i = 0; i < cachedIdArr.length; i += 500) {
        const chunk = cachedIdArr.slice(i, i + 500)
        const { error, count } = await supabase
          .from("wallet_moments_cache")
          .update({ last_seen_at: touchedAt }, { count: "exact" })
          .eq("wallet_address", wallet)
          .eq("collection_id", collectionId)
          .in("moment_id", chunk)
        if (error) {
          console.log("[cache-refresh] last_seen_at update err: " + error.message)
        } else if (count != null) {
          lastSeenTouched += count
        } else {
          // ⛔ THE THIRD STATE: the update SUCCEEDED but PostgREST returned no
          // count despite `{ count: "exact" }`. Adding nothing was silent, so
          // `last_seen_touched` in the response below under-reported by a whole
          // chunk while still reading as an exact measurement.
          console.log(
            "[cache-refresh] last_seen_at update returned no count for a chunk of " +
              chunk.length +
              " — last_seen_touched is a FLOOR for this run, not an exact count",
          )
        }
      }
    }

    if (newIds.length === 0 && sp.get("refreshLocked") !== "1") {
      return NextResponse.json({
        ok: true, total_on_chain: onChainIds.length, total_cached: cachedIds.size,
        new_stubs_inserted: 0, enriched: 0, removed_count: removedCount,
        last_seen_touched: lastSeenTouched,
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
        // 3-column conflict target — the wmc unique constraint became
        // (wallet_address, collection_id, moment_id) on 2026-05-06. The old
        // 2-column target errored ("no unique constraint matching ON CONFLICT")
        // on every call. rows already carry collection_id (set above).
        .upsert(rows, { onConflict: "wallet_address,collection_id,moment_id" })
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

      // May 9 dedup project: prefer canonical UUID-format external_ids over
      // the integer "set:play" keys built from on-chain metadata. One batch
      // SELECT against editions before the per-moment update loop avoids
      // landing fresh wmc rows on the int-format key and creating new
      // orphans for the canonicalize trigger to chase.
      const canonicalKeyByInt = new Map<string, string>()
      if (isTopShot) {
        const intKeys = Array.from(new Set(
          results
            .map(r => r.meta ? scripts.buildEditionKey(r.meta) : null)
            .filter((k): k is string => !!k && /^\d+:\d+$/.test(k))
        ))
        for (let i = 0; i < intKeys.length; i += 200) {
          const chunk = intKeys.slice(i, i + 200)
          const setIds = Array.from(new Set(
            chunk.map(k => Number(k.split(":")[0])).filter(n => Number.isFinite(n))
          ))
          const playIds = Array.from(new Set(
            chunk.map(k => Number(k.split(":")[1])).filter(n => Number.isFinite(n))
          ))
          if (setIds.length === 0 || playIds.length === 0) continue
          const { data: edRows } = await supabase
            .from("editions")
            .select("external_id, set_id_onchain, play_id_onchain")
            .eq("collection_id", collectionId)
            .in("set_id_onchain", setIds)
            .in("play_id_onchain", playIds)
          for (const row of edRows ?? []) {
            if (row.set_id_onchain == null || row.play_id_onchain == null) continue
            const intKey = `${row.set_id_onchain}:${row.play_id_onchain}`
            const isInt = /^\d+:\d+$/.test(String(row.external_id ?? ""))
            const existing = canonicalKeyByInt.get(intKey)
            // Equivalent to: ORDER BY (external_id ~ '^[0-9]+:[0-9]+$') ASC LIMIT 1
            if (!existing || (!isInt && /^\d+:\d+$/.test(existing))) {
              canonicalKeyByInt.set(intKey, String(row.external_id))
            }
          }
        }
      }

      let lockedCount = 0
      const enrichedKeysById = new Map<string, string>()
      for (const { id, meta, gql } of results) {
        if (!meta) continue
        const rawEditionKey = scripts.buildEditionKey(meta)
        const editionKey = rawEditionKey
          ? (canonicalKeyByInt.get(rawEditionKey) ?? rawEditionKey)
          : rawEditionKey
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
        if (!error) {
          enriched++
          if (editionKey) enrichedKeysById.set(id, editionKey)
        }
      }
      console.log("[cache-refresh] isLocked: " + lockedCount + "/" + results.length + " moments locked")

      // Step 6b: For non-TopShot collections, populate fmv_usd on the rows we
      // just enriched. wallet-search is the existing FMV writer for TS+AllDay
      // but isn't always called for the non-TS collections, so brand-new wmc
      // rows would otherwise stay NULL forever. Joins editions.external_id ↔
      // wmc.edition_key and applies a defensive ceiling: cap at $10K unless
      // the snapshot is HIGH confidence with sales_count_30d >= 3 (guards
      // against the known FMV pipeline outliers in LaLiga / AllDay).
      if (!isTopShot && enrichedKeysById.size > 0) {
        const keys = [...new Set(enrichedKeysById.values())]
        const extToFmv = new Map<string, number | null>()
        try {
          const CHUNK_KEYS = 100
          const extToInternal = new Map<string, string>()
          for (let i = 0; i < keys.length; i += CHUNK_KEYS) {
            const slice = keys.slice(i, i + CHUNK_KEYS)
            const { data: edRows } = await supabase
              .from("editions")
              .select("id, external_id")
              .eq("collection_id", collectionId)
              .in("external_id", slice)
            for (const r of edRows ?? []) {
              if (r.external_id && r.id) extToInternal.set(r.external_id, r.id)
            }
          }
          const internalIds = [...new Set(extToInternal.values())]
          const fmvByInternal = new Map<string, { fmv_usd: number | null; confidence: string | null; sales_count_30d: number | null }>()
          for (let i = 0; i < internalIds.length; i += CHUNK_KEYS) {
            const slice = internalIds.slice(i, i + CHUNK_KEYS)
            // fmv_current = DISTINCT-ON latest-per-edition (1 row/edition), so cold
            // editions aren't dropped past the raw-fmv_snapshots 1000-row cap.
            const { data: snaps } = await supabase
              .from("fmv_current")
              .select("edition_id, fmv_usd, confidence, sales_count_30d, computed_at")
              .in("edition_id", slice)
            for (const s of snaps ?? []) {
              if (!fmvByInternal.has(s.edition_id)) {
                fmvByInternal.set(s.edition_id, {
                  fmv_usd: s.fmv_usd != null ? Number(s.fmv_usd) : null,
                  confidence: s.confidence ?? null,
                  sales_count_30d: s.sales_count_30d != null ? Number(s.sales_count_30d) : null,
                })
              }
            }
          }
          for (const [extId, internalId] of extToInternal) {
            const snap = fmvByInternal.get(internalId)
            if (!snap) { extToFmv.set(extId, null); continue }
            const v = snap.fmv_usd
            if (v == null || !Number.isFinite(v)) { extToFmv.set(extId, null); continue }
            if (v <= 10000) { extToFmv.set(extId, v); continue }
            const isHigh = String(snap.confidence ?? "").toUpperCase() === "HIGH"
            const c = Number(snap.sales_count_30d ?? 0)
            extToFmv.set(extId, isHigh && c >= 3 ? v : null)
          }
        } catch (e: any) {
          console.log("[cache-refresh] fmv lookup err: " + (e?.message ?? "unknown"))
        }

        let fmvWritten = 0
        for (const [id, key] of enrichedKeysById) {
          const fmv = extToFmv.get(key) ?? null
          if (fmv == null) continue
          const { error } = await supabase
            .from("wallet_moments_cache")
            .update({ fmv_usd: fmv })
            .eq("wallet_address", wallet)
            .eq("moment_id", id)
          if (!error) fmvWritten++
        }
        console.log("[cache-refresh] fmv_usd written for " + fmvWritten + "/" + enrichedKeysById.size + " (" + collectionSlug + ")")
      }
    }

    console.log("[cache-refresh] Done: stubs=" + stubsInserted + " enriched=" + enriched +
      " elapsed=" + (Date.now() - startTime) + "ms")

    // Step 7: Optional is_locked backfill for ALL cached moments (triggered by refreshLocked=1)
    let lockedBackfillCount = 0
    let lockedBackfillTotal = 0
    // null = the stale-row count failed, so the remainder is UNKNOWN (never 0).
    let lockedBackfillRemaining: number | null = 0
    const refreshLocked = sp.get("refreshLocked") === "1"
    if (refreshLocked && collectionSlug === "nba-top-shot") {
      // On-demand lock refresh for the wallet being VIEWED. This is what makes
      // displayed lock counts trustworthy — the batch pipeline (lock-check-batch)
      // physically can't keep 1.6M rows within its 7-day promise (~24x short), so
      // freshness on the wallet a user actually looks at has to come from here.
      //
      // Two correctness fixes vs the prior body (2026-07-19):
      //  1. STALEST-FIRST, not the first 500 in on-chain order. The old body re-checked
      //     the same first-500 moments on every view, so a whale's moments 501+ never
      //     refreshed and an overstated wallet (stale is_locked=true) never self-corrected.
      //     Ordering by lock_checked_at NULLS FIRST advances the wallet's freshness
      //     frontier each view — a whale converges over a few views.
      //  2. STAMP lock_checked_at (old body wrote only is_locked). Without the stamp the
      //     row still looks stale forever, so freshness could never be recorded here and
      //     the batch kept re-selecting it. Now an on-demand refresh is a real check.
      // A fresh wallet early-outs at ~one indexed query (staleTotal === 0 → no GQL), so
      // firing this on every TS view (the trigger's <500 guard was removed) is cheap.
      const CAP = 500
      const LOCK_MAX_AGE_DAYS = 7
      const staleCutoffIso = new Date(Date.now() - LOCK_MAX_AGE_DAYS * 86400000).toISOString()
      const staleFilter = "lock_checked_at.is.null,lock_checked_at.lt." + staleCutoffIso

      // One query: stalest CAP rows + exact count of all stale rows (for `remaining`).
      // ⚠ CORRECTED 2026-09-19: this comment used to read "reconciled earlier in this route",
      // which is FALSE — this route never deletes. Removal happens in `upsert_wallet_moments`
      // (full-set writer), `prune_stale_wmc()` (jobid 199, weekly) and
      // `purge_candy_wmc_ghost_rows()` (jobid 201, daily). So these rows are the wallet's live
      // holdings AS OF THE LAST FULL-SET WRITE OR PRUNE, not as of this request — which matters
      // because a weekly prune means the tail can be up to a week behind on this path.
      const { data: staleRows, count: staleTotal, error: staleErr } = await supabase
        .from("wallet_moments_cache")
        .select("moment_id", { count: "exact" })
        .eq("wallet_address", wallet)
        .eq("collection_id", collectionId)
        .or(staleFilter)
        .order("lock_checked_at", { ascending: true, nullsFirst: true })
        .limit(CAP)

      const toRefreshLocked = (staleRows ?? [])
        .map(function(r: any) { return String(r.moment_id) })
        .filter(Boolean)
      lockedBackfillTotal = toRefreshLocked.length
      // ⚠ `remaining` is what the client reads to decide whether to schedule
      // another pass. supabase-js returns a failed count as `{ count: null, error }`,
      // and `(Number(null) || 0) - total` clamped to 0 — "every locked-status row on
      // this wallet is fresh now" manufactured from a timed-out read (2026-09-03).
      // NULL says unknown; the client's `> 0` check simply does not fire on it.
      if (staleErr) console.warn("[cache-refresh] stale-row count failed; remaining is unknown:", staleErr.message)
      lockedBackfillRemaining = staleErr || typeof staleTotal !== "number"
        ? null
        : Math.max(0, staleTotal - lockedBackfillTotal)

      if (toRefreshLocked.length === 0) {
        console.log("[cache-refresh] is_locked backfill: wallet fresh, nothing to do")
      } else {
        if ((lockedBackfillRemaining ?? 0) > 0) {
          console.log("[cache-refresh] is_locked backfill: refreshing " + toRefreshLocked.length + " stalest of " + staleTotal + " stale (" + lockedBackfillRemaining + " remain for next view)")
        }
        const nowIso = new Date().toISOString()

        // Batch GQL in groups of 10, concurrency 5
        const batches: string[][] = []
        for (let i = 0; i < toRefreshLocked.length; i += 10) {
          batches.push(toRefreshLocked.slice(i, i + 10))
        }

        await mapWithConcurrency(batches, 5, async function(batch) {
          const results = await Promise.all(batch.map(function(id) { return fetchMomentGql(id) }))
          // Group the batch by the value being written so it costs at most TWO
          // statements instead of one per moment. Each single-row UPDATE here
          // filtered on (wallet_address, moment_id) with no collection_id, so it
          // could not use the (wallet_address, collection_id, moment_id) unique
          // index as a full match and re-scanned the wallet's rows every time:
          // 7,689 buffers per single-row update, 1,268,710 buffers over 165 calls
          // in one 40-minute window (pg_stat_statements, 2026-09-01).
          // ⚠ What batching removes is the repeated scan, NOT the per-row index
          // maintenance: every index on lock_checked_at makes this a non-HOT
          // update (20260809010000_audit_20260809_allday_lock_picker_skipscan.sql).
          const lockedIds: string[] = []
          const unlockedIds: string[] = []
          for (let j = 0; j < batch.length; j++) {
            const gqlData = results[j]
            // GQL miss → leave the row stale + unstamped so a later view retries it,
            // rather than stamping an unverified value.
            if (gqlData == null) continue
            if (gqlData.isLocked === true) lockedIds.push(batch[j])
            else unlockedIds.push(batch[j])
          }
          const lockGroups = [
            { locked: true, ids: lockedIds },
            { locked: false, ids: unlockedIds },
          ]
          for (const g of lockGroups) {
            if (g.ids.length === 0) continue
            const { error: lockErr } = await supabase
              .from("wallet_moments_cache")
              .update({ is_locked: g.locked, lock_checked_at: nowIso })
              .eq("wallet_address", wallet)
              .in("moment_id", g.ids)
            // Count what was WRITTEN, not what was intended. Incrementing before
            // the update (as this did) reported rows as locked even when the
            // write that was supposed to record it never landed.
            if (lockErr) {
              console.error("[cache-refresh] is_locked backfill: update failed for " + g.ids.length + " moment(s): " + lockErr.message)
              continue
            }
            if (g.locked) lockedBackfillCount += g.ids.length
          }
        })

        console.log("[cache-refresh] is_locked backfill complete: " + lockedBackfillCount + "/" + lockedBackfillTotal + " locked")
      }
    }

    return NextResponse.json({
      ok: true,
      total_on_chain: onChainIds.length,
      total_cached: cachedIds.size + stubsInserted,
      new_stubs_inserted: stubsInserted,
      enriched,
      removed_count: removedCount,
      last_seen_touched: lastSeenTouched,
      locked_backfill: refreshLocked ? { total: lockedBackfillTotal, locked: lockedBackfillCount, remaining: lockedBackfillRemaining } : undefined,
      elapsed: Date.now() - startTime,
    })
  } catch (e: any) {
    console.error("[cache-refresh] FATAL:", e.message || "unknown", e.stack || "")
    return NextResponse.json({ ok: false, error: e.message || "Unknown error" }, { status: 500 })
  }
}
