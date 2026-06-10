import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import fcl from "@/lib/flow"
import * as t from "@onflow/types"
import { topshotGraphql } from "@/lib/topshot"
import { getOrSetCache } from "@/lib/cache"
import { supabaseAdmin } from "@/lib/supabase"
import {
  normalizeParallel,
  normalizeSetName,
  buildEditionScopeKey,
} from "@/lib/wallet-normalize"
import { resolveTopShotUsernameCacheAware } from "@/lib/topshot-username-resolve"
import { detectAddressChain } from "@/lib/address"
import { getCurrentUser } from "@/lib/auth/supabase-server"
import { awardPoints } from "@/lib/rewards"

type WalletRow = {
  momentId: string
  playerName: string
  team?: string
  league?: string
  setName: string
  series?: string
  tier?: string
  serial?: number
  mintSize?: number
  serialNumber?: number | null
  circulationCount?: number | null
  officialBadges?: string[]
  specialSerialTraits?: string[]
  isLocked?: boolean
  bestAsk?: number | null
  bestOffer?: number | null
  lowAsk?: number | null
  lastPurchasePrice?: number | null
  acquiredAt?: string | null
  editionKey?: string | null
  parallel?: string | null
  subedition?: string | null
  editionsOwned?: number
  editionsLocked?: number
  flowId?: string | null
  thumbnailUrl?: string | null
  tssPoints?: number | null
  fmv?: number | null
  marketConfidence?: string | null
  fmvComputedAt?: string | null
  acquisitionMethod?: string | null
  buyPrice?: number | null
  acquisitionConfidence?: string | null
  costBasis?: number | null
  costBasisLabel?: string | null
}

type AcquisitionStats = {
  pack_pull_count: number
  marketplace_count: number
  challenge_reward_count: number
  gift_count: number
  total_count: number
  locked_count: number
  total_spent: number
}

type WalletSearchResponse = {
  rows: WalletRow[]
  walletAddress?: string
  summary: {
    totalMoments: number
    returnedMoments: number
    remainingMoments: number
    totalTssPoints?: number
  }
  acquisitionStats?: AcquisitionStats | null
  error?: string
}

type MintedMomentGraphqlData = {
  getMintedMoment?: {
    data?: {
      flowId?: string | null
      flowSerialNumber?: string | null
      tier?: string | null
      forSale?: boolean | null
      price?: string | number | null
      lastPurchasePrice?: string | number | null
      isLocked?: boolean | null
      createdAt?: string | null
      badges?: Array<{
        type?: string | null
        iconSvg?: string | null
      }> | null
      set?: {
        id?: string | null
        leagues?: Array<string | null> | null
      } | null
      play?: {
        id?: string | null
        stats?: { jerseyNumber?: string | null } | null
      } | null
      topshotScore?: { score?: number | null } | null
    } | null
  } | null
}

const OWNED_IDS_TTL = 1000 * 60 * 10
const METADATA_TTL = 1000 * 60 * 30
const GQL_MOMENT_TTL = 1000 * 60 * 10

function isWalletAddress(value: string) {
  return /^0x[a-fA-F0-9]{16}$/.test(value.trim())
}

function ensureFlowPrefix(v: string) {
  return v.startsWith("0x") ? v : `0x${v}`
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function formatTier(value: string | null): string | null {
  if (!value) return null
  const normalized = value.replace(/_/g, " ").toLowerCase()
  if (normalized.includes("common")) return "Common"
  if (normalized.includes("fandom")) return "Fandom"
  if (normalized.includes("rare")) return "Rare"
  if (normalized.includes("legendary")) return "Legendary"
  if (normalized.includes("ultimate")) return "Ultimate"
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function specialSerialTraits(
  serial: number | null,
  mint: number | null,
  graphqlBadgeTypes: string[]
): string[] {
  const out: string[] = []
  if (serial === 1) out.push("#1 Serial")
  if (serial !== null && mint !== null && mint > 0 && serial === mint) {
    out.push("Original Perfect Mint Serial")
  }
  for (const badgeType of graphqlBadgeTypes) {
    const upper = (badgeType ?? "").toUpperCase()
    if (upper.includes("JERSEY") && !out.includes("Jersey")) out.push("Jersey")
    if ((upper === "#1" || upper === "#1_SERIAL" || upper.includes("FIRST_SERIAL")) && !out.includes("#1 Serial")) out.push("#1 Serial")
    if ((upper.includes("PERFECT_MINT") || upper.includes("PERFECT MINT")) && !out.includes("Original Perfect Mint Serial")) out.push("Original Perfect Mint Serial")
  }
  return out
}

function buildThumbnailUrl(flowId: string | null) {
  if (!flowId) return null
  return `https://assets.nbatopshot.com/media/${flowId}/image?width=180`
}

function cleanErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)

  if (raw.includes("<html") || raw.includes("<title>") || raw.includes("<!DOCTYPE")) {
    if (raw.toLowerCase().includes("slow down") || raw.includes("429") || raw.toLowerCase().includes("too many request")) {
      return "Top Shot is rate limiting requests right now. Wait 30\u201360 seconds and try again."
    }
    if (raw.toLowerCase().includes("error") || raw.toLowerCase().includes("unavailable")) {
      return "Top Shot is temporarily unavailable. Try again in a moment."
    }
    return "Top Shot returned an unexpected response. Try again in a moment."
  }

  if (raw.includes("429") || raw.toLowerCase().includes("too many request") || raw.toLowerCase().includes("rate limit")) {
    return "Top Shot is rate limiting requests right now. Wait 30\u201360 seconds and try again."
  }

  if (raw.toLowerCase().includes("could not resolve username")) {
    return "Username not found. Check the spelling and try again."
  }

  if (raw.toLowerCase().includes("no collection") || raw.toLowerCase().includes("no nft")) {
    return "This wallet has no Top Shot moments."
  }

  return raw
}

async function withRetry<T>(fn: () => Promise<T>, delayMs = 2000): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (
      msg.includes("429") ||
      msg.toLowerCase().includes("too many request") ||
      msg.toLowerCase().includes("slow down") ||
      (msg.includes("<html") && msg.toLowerCase().includes("slow down"))
    ) {
      await new Promise<void>(function(resolve) { setTimeout(resolve, delayMs) })
      return await fn()
    }
    throw err
  }
}

async function resolveWalletFromInput(input: string): Promise<string> {
  const trimmed = input.trim()
  if (isWalletAddress(trimmed)) return ensureFlowPrefix(trimmed)

  // Username path. Layered resolver: wallet_usernames → seeded_wallets →
  // saved_wallets → user_profiles → live Top Shot GQL via topshot-proxy.
  // Hits at the live layer are written back to wallet_usernames so the next
  // call short-circuits at layer 1. The 10-min in-process getOrSetCache
  // wrapper that used to live here is now redundant with the Postgres cache
  // and was dropped to keep username-to-wallet a single source of truth.
  const outcome = await resolveTopShotUsernameCacheAware(supabaseAdmin, trimmed)
  if (outcome.found) return outcome.walletAddress
  // Surface the same error message clients have always received for unresolved
  // usernames so the UI's existing copy ("Username not found...") still fires.
  throw new Error("Could not resolve username to wallet address.")
}

async function getOwnedMomentIds(wallet: string): Promise<number[]> {
  return getOrSetCache(`owned:${wallet}`, OWNED_IDS_TTL, async () => {
    const cadence = `
      import TopShot from 0x0b2a3299cc857e29
      access(all)
      fun main(address: Address): [UInt64] {
        let acct = getAccount(address)
        let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
        if col == nil { return [] }
        return col!.getIDs()
      }
    `
    const result = await fcl.query({
      cadence,
      args: (arg: any) => [arg(wallet, t.Address)],
    })
    return Array.isArray(result) ? (result as number[]) : []
  })
}

async function getAllDayOwnedIds(wallet: string): Promise<number[]> {
  return getOrSetCache(`owned-allday:${wallet}`, OWNED_IDS_TTL, async () => {
    const cadence = `
      import AllDay from 0xe4cf4bdc1751c65d
      access(all)
      fun main(address: Address): [UInt64] {
        let acct = getAccount(address)
        let col = acct.capabilities.borrow<&{AllDay.MomentNFTCollectionPublic}>(/public/AllDayNFTCollection)
        if col == nil { return [] }
        return col!.getIDs()
      }
    `
    const result = await fcl.query({
      cadence,
      args: (arg: any) => [arg(wallet, t.Address)],
    })
    return Array.isArray(result) ? (result as number[]) : []
  })
}

async function getMomentMetadata(wallet: string, id: number) {
  return getOrSetCache(`metadata:${wallet}:${id}`, METADATA_TTL, async () => {
    // Non-panicking variant: always pulls setID/playID/serial directly from
    // moment.data (resource fields on TopShot.NFT) so edition_key resolution
    // does not depend on metadata view availability. Falls back to empty
    // strings for rich fields if TopShotMomentMetadataView cannot be
    // resolved (e.g. for some newer moment types).
    const cadence = `
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
            "setID": setID
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
          "setID": setID
        }
      }
    `
    const result = await fcl.query({
      cadence,
      args: (arg: any) => [arg(wallet, t.Address), arg(String(id), t.UInt64)],
    })
    return result as Record<string, string>
  })
}

async function fetchMomentGraphQL(id: string) {
  return getOrSetCache(`gql-moment:${id}`, GQL_MOMENT_TTL, async () => {
    const q = `
      query GetMoment($id: ID!) {
        getMintedMoment(momentId: $id) {
          data {
            flowId flowSerialNumber tier forSale price lastPurchasePrice isLocked createdAt
            badges { type iconSvg }
            play { id stats { jerseyNumber } }
            set { id leagues }
            topshotScore { score }
          }
        }
      }
    `
    const d = await withRetry(function() {
      return topshotGraphql<MintedMomentGraphqlData>(q, { id })
    })
    const m = d?.getMintedMoment?.data
    return {
      flowId: m?.flowId ?? null,
      serial: toNum(m?.flowSerialNumber),
      tier: formatTier(m?.tier ?? null),
      bestAsk: m?.forSale ? toNum(m?.price) : null,
      lowAsk: m?.forSale ? toNum(m?.price) : null,
      bestOffer: null,
      lastPurchasePrice: toNum(m?.lastPurchasePrice),
      isLocked: !!m?.isLocked,
      acquiredAt: m?.createdAt ?? null,
      jerseyNumber: m?.play?.stats?.jerseyNumber ? parseInt(m.play.stats.jerseyNumber, 10) : null,
      league: m?.set?.leagues?.find(Boolean) ?? null,
      badges: Array.isArray(m?.badges)
        ? m.badges.map((b) => ({ type: b?.type ?? "UNKNOWN", iconSvg: b?.iconSvg ?? "" }))
        : [],
      tssPoints: toNum(m?.topshotScore?.score) ?? null,
      setID: m?.set?.id ?? null,
      playID: m?.play?.id ?? null,
    }
  })
}

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

async function seedEditionsToSupabase(rows: WalletRow[], collectionId: string) {
  for (const row of rows) {
    try {
      if (!row.editionKey) continue

      const tier = row.tier?.toUpperCase() ?? "COMMON"
      const normalizedTier =
        tier.includes("LEGENDARY") ? "LEGENDARY" :
        tier.includes("RARE") ? "RARE" :
        tier.includes("ULTIMATE") ? "ULTIMATE" :
        tier.includes("UNCOMMON") ? "UNCOMMON" :
        tier.includes("FANDOM") ? "FANDOM" : "COMMON"

      let playerId: string | null = null
      if (row.playerName && row.playerName !== "Unknown Player") {
        const { data: player } = await supabaseAdmin
          .from("players")
          .upsert(
            {
              external_id: `flow:${row.editionKey.split(":")[1] ?? row.playerName}`,
              collection_id: collectionId,
              name: row.playerName,
              team: row.team ?? null,
            },
            { onConflict: "external_id,collection_id", ignoreDuplicates: false }
          )
          .select("id")
          .single()
        playerId = player?.id ?? null
      }

      const { data: edition } = await supabaseAdmin
        .from("editions")
        .upsert(
          {
            external_id: row.editionKey,
            collection_id: collectionId,
            player_id: playerId,
            name: `${row.playerName} \u2014 ${row.setName}`,
            tier: normalizedTier as any,
            series: toNum(row.series),
            circulation_count: row.mintSize ?? null,
          },
          { onConflict: "external_id,collection_id", ignoreDuplicates: false }
        )
        .select("id")
        .single()

      if (!edition?.id) continue
      // Sales and FMV snapshots are only written by the real ingest pipeline
      // and fmv-recalc cron — never seeded from wallet purchase prices.
    } catch {
      // Never let seeding errors bubble up to the user
    }
  }
}

async function getCollectionId(): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin
      .from("collections")
      .select("id")
      .eq("slug", "nba_top_shot")
      .single()
    return data?.id ?? null
  } catch {
    return null
  }
}

const SLUG_TO_DB_SLUG: Record<string, string> = {
  "nba-top-shot": "nba_top_shot",
  "nfl-all-day": "nfl_all_day",
  "laliga-golazos": "laliga_golazos",
  "disney-pinnacle": "disney_pinnacle",
  "ufc": "ufc",
}

const COLLECTION_ID_CACHE = new Map<string, string | null>()
async function getCollectionIdForSlug(slug?: string): Promise<string | null> {
  const dbSlug = SLUG_TO_DB_SLUG[slug ?? ""] ?? "nba_top_shot"
  if (COLLECTION_ID_CACHE.has(dbSlug)) return COLLECTION_ID_CACHE.get(dbSlug) ?? null
  try {
    const { data } = await supabaseAdmin
      .from("collections")
      .select("id")
      .eq("slug", dbSlug)
      .single()
    const id = data?.id ?? null
    COLLECTION_ID_CACHE.set(dbSlug, id)
    return id
  } catch {
    return null
  }
}

// ── Batch FMV + Ask Enrichment ────────────────────────────────────
// Resolves integer editionKeys → Supabase edition UUIDs → fmv_snapshots
// Upserts missing editions so integer-format keys always resolve.
// Also looks up cached_listings by flowId for low ask prices.
async function batchEnrichFmvAndAsks(rows: WalletRow[]): Promise<WalletRow[]> {
  if (!rows.length) return rows

  try {
    // 1. Collect unique editionKeys and flowIds
    const editionKeys = [...new Set(rows.map(r => r.editionKey).filter(Boolean))] as string[]
    const flowIds = [...new Set(rows.map(r => r.flowId).filter(Boolean))] as string[]

    const CHUNK = 50

    // 2. Batch upsert any missing editions so integer-format keys exist
    //    (ignoreDuplicates: true means existing rows are untouched)
    if (editionKeys.length) {
      let collectionId: string | null = null
      try {
        collectionId = await getCollectionId()
      } catch { /* proceed without collection_id */ }

      const upsertChunks: Promise<any>[] = []
      for (let i = 0; i < editionKeys.length; i += CHUNK) {
        upsertChunks.push(
          (supabaseAdmin as any)
            .from("editions")
            .upsert(
              editionKeys.slice(i, i + CHUNK).map(k => ({
                external_id: k,
                ...(collectionId ? { collection_id: collectionId } : {}),
              })),
              { onConflict: "external_id,collection_id", ignoreDuplicates: true }
            )
        )
      }
      await Promise.all(upsertChunks)
    }

    // 3. Parallel: resolve editions + fetch cached_listings
    const editionChunks: Promise<any>[] = []
    for (let i = 0; i < editionKeys.length; i += CHUNK) {
      editionChunks.push(
        (supabaseAdmin as any)
          .from("editions")
          .select("id, external_id")
          .in("external_id", editionKeys.slice(i, i + CHUNK))
      )
    }

    const listingChunks: Promise<any>[] = []
    for (let i = 0; i < flowIds.length; i += CHUNK) {
      listingChunks.push(
        (supabaseAdmin as any)
          .from("cached_listings")
          .select("flow_id, ask_price, fmv")
          .in("flow_id", flowIds.slice(i, i + CHUNK))
      )
    }

    const [editionResults, listingResults] = await Promise.all([
      Promise.all(editionChunks),
      Promise.all(listingChunks),
    ])

    // 4. Build edition external_id → internal UUID map
    const extToId = new Map<string, string>()
    for (const { data } of editionResults) {
      for (const row of (data ?? [])) {
        extToId.set(row.external_id, row.id)
      }
    }

    // 5. Build flowId → ask_price map from cached_listings
    const askMap = new Map<string, number>()
    for (const { data } of listingResults) {
      for (const row of (data ?? [])) {
        if (row.ask_price != null) askMap.set(row.flow_id, Number(row.ask_price))
      }
    }

    // 6. Fetch FMV snapshots for resolved edition UUIDs
    const internalIds = [...new Set(extToId.values())]
    const fmvMap = new Map<string, { fmv_usd: number; confidence: string; computed_at: string }>()

    if (internalIds.length) {
      const fmvChunks: Promise<any>[] = []
      for (let i = 0; i < internalIds.length; i += CHUNK) {
        fmvChunks.push(
          (supabaseAdmin as any)
            .from("fmv_snapshots")
            .select("edition_id, fmv_usd, confidence, sales_count_30d, computed_at")
            .in("edition_id", internalIds.slice(i, i + CHUNK))
            .order("computed_at", { ascending: false })
        )
      }
      const fmvResults = await Promise.all(fmvChunks)
      for (const { data } of fmvResults) {
        for (const row of (data ?? [])) {
          // Keep only the most recent snapshot per edition
          if (!fmvMap.has(row.edition_id)) fmvMap.set(row.edition_id, row)
        }
      }
    }

    // 7. Build editionKey → FMV data map.
    // Defensive ceiling: discard fmv_usd > $10K unless the snapshot is HIGH
    // confidence with sales_count_30d >= 3. Guards against known FMV pipeline
    // outliers (12 LaLiga + 11 AllDay editions currently emit $900K-$1M values
    // from low-data fallbacks).
    const editionFmvMap = new Map<string, { fmv: number; confidence: string; computedAt: string }>()
    for (const [extId, intId] of extToId) {
      const snap = fmvMap.get(intId)
      if (!snap) continue
      const raw = Number(snap.fmv_usd)
      if (!Number.isFinite(raw)) continue
      const isHigh = String(snap.confidence ?? "").toUpperCase() === "HIGH"
      const sc = Number((snap as any).sales_count_30d ?? 0)
      if (raw > 10000 && !(isHigh && sc >= 3)) continue
      editionFmvMap.set(extId, {
        fmv: raw,
        confidence: (snap.confidence ?? "low").toLowerCase(),
        computedAt: snap.computed_at,
      })
    }

    // 7b. Fallback: for edition keys that didn't resolve, try alternate format
    // Some editions.external_id use UUID format (setUUID:playUUID), while
    // wallet moments use numeric format (setID:playID). For unmatched numeric
    // keys, look the edition up by play_id_onchain (typed integer column,
    // backed by idx_editions_play_id_onchain). Replaces a previous leading-
    // wildcard ILIKE on external_id that forced a Seq Scan over editions and
    // was the source of statement-timeout cancellations under smoke-test load.
    const unmatchedKeys = editionKeys.filter(k => !editionFmvMap.has(k))
    if (unmatchedKeys.length > 0) {
      try {
        const playIds: number[] = []
        for (const key of unmatchedKeys) {
          const parts = key.split(":")
          if (parts.length !== 2) continue
          const n = parseInt(parts[1], 10)
          if (Number.isFinite(n)) playIds.push(n)
        }

        const fallbackChunks: Promise<any>[] = []
        for (let i = 0; i < playIds.length; i += CHUNK) {
          fallbackChunks.push(
            (supabaseAdmin as any)
              .from("editions")
              .select("id, play_id_onchain")
              .in("play_id_onchain", playIds.slice(i, i + CHUNK))
          )
        }

        if (fallbackChunks.length > 0) {
          const fallbackResults = await Promise.all(fallbackChunks)
          // Build playID → edition UUID map from fallback results
          const playIdToEdition = new Map<string, string>()
          for (const { data } of fallbackResults) {
            for (const row of (data ?? [])) {
              if (row.play_id_onchain != null && row.id) {
                playIdToEdition.set(String(row.play_id_onchain), row.id)
              }
            }
          }

          // Fetch FMV snapshots for any newly found edition UUIDs
          const newInternalIds = [...new Set(playIdToEdition.values())]
            .filter(id => !fmvMap.has(id))

          if (newInternalIds.length > 0) {
            const newFmvChunks: Promise<any>[] = []
            for (let i = 0; i < newInternalIds.length; i += CHUNK) {
              newFmvChunks.push(
                (supabaseAdmin as any)
                  .from("fmv_snapshots")
                  .select("edition_id, fmv_usd, confidence, sales_count_30d, computed_at")
                  .in("edition_id", newInternalIds.slice(i, i + CHUNK))
                  .order("computed_at", { ascending: false })
              )
            }
            const newFmvResults = await Promise.all(newFmvChunks)
            for (const { data } of newFmvResults) {
              for (const row of (data ?? [])) {
                if (!fmvMap.has(row.edition_id)) fmvMap.set(row.edition_id, row)
              }
            }
          }

          // Map unmatched numeric keys to FMV via playID. Re-applies the same
          // sanity ceiling as the primary lookup above.
          for (const key of unmatchedKeys) {
            const parts = key.split(":")
            if (parts.length !== 2) continue
            const editionUuid = playIdToEdition.get(parts[1])
            if (!editionUuid) continue
            const snap = fmvMap.get(editionUuid)
            if (!snap) continue
            const raw = Number(snap.fmv_usd)
            if (!Number.isFinite(raw)) continue
            const isHigh = String(snap.confidence ?? "").toUpperCase() === "HIGH"
            const sc = Number((snap as any).sales_count_30d ?? 0)
            if (raw > 10000 && !(isHigh && sc >= 3)) continue
            editionFmvMap.set(key, {
              fmv: raw,
              confidence: (snap.confidence ?? "low").toLowerCase(),
              computedAt: snap.computed_at,
            })
          }
        }
      } catch (fallbackErr) {
        console.warn("[wallet-search] FMV fallback lookup failed:", fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr))
      }
    }

    // 8. Apply FMV + ask data to rows
    let enrichedCount = 0
    const enrichedRows = rows.map(row => {
      const fmvData = row.editionKey ? editionFmvMap.get(row.editionKey) : null
      const cachedAsk = row.flowId ? askMap.get(row.flowId) : null

      if (fmvData) enrichedCount++

      return {
        ...row,
        fmv: fmvData?.fmv ?? null,
        marketConfidence: fmvData?.confidence ?? null,
        fmvComputedAt: fmvData?.computedAt ?? null,
        // Use cached_listings ask if available; keep GQL ask as fallback
        lowAsk: cachedAsk ?? row.lowAsk ?? null,
      }
    })

    console.log(`[wallet-search] FMV enrichment: ${enrichedCount}/${rows.length} moments enriched with FMV`)
    return enrichedRows
  } catch (err) {
    console.warn("[wallet-search] FMV/ask enrichment failed:", err instanceof Error ? err.message : String(err))
    return rows
  }
}

const ACQUISITION_LABELS: Record<string, string | null> = {
  marketplace: "Bought",
  pack_pull: "Pack",
  loan_default: "Loan",
  gift: "Gift",
  challenge_reward: "Reward",
  airdrop: "Airdrop",
  unknown: null,
}

async function enrichWithAcquisitionData(rows: WalletRow[], wallet: string): Promise<WalletRow[]> {
  if (!rows.length) return rows
  try {
    const momentIds = rows.map(r => r.momentId).filter(Boolean)
    if (!momentIds.length) return rows

    const { data, error } = await (supabaseAdmin as any).rpc("get_wallet_acquisition_data", {
      p_wallet: wallet,
      p_moment_ids: momentIds,
    })

    if (error || !data) return rows

    const acqMap = new Map<string, { acquisition_method: string; buy_price: number | null; loan_principal: number | null }>()
    for (const row of data) {
      // Keep first match per moment (ordered by nft_id in the RPC)
      if (!acqMap.has(row.moment_id)) {
        acqMap.set(row.moment_id, row)
      }
    }

    return rows.map(row => {
      const acq = acqMap.get(row.momentId)
      if (!acq) return row
      const method = acq.acquisition_method
      const costBasis = method === "marketplace" ? (acq.buy_price != null ? Number(acq.buy_price) : null)
        : method === "loan_default" ? (acq.loan_principal != null ? Number(acq.loan_principal) : null)
        : null
      return {
        ...row,
        acquisitionMethod: method,
        buyPrice: acq.buy_price != null ? Number(acq.buy_price) : null,
        costBasis,
        costBasisLabel: ACQUISITION_LABELS[method] ?? null,
      }
    })
  } catch (err) {
    console.warn("[wallet-search] Acquisition enrichment failed:", err instanceof Error ? err.message : String(err))
    return rows
  }
}

async function progressivelyClassify(rows: WalletRow[], wallet: string) {
  try {
    const walletAddr = wallet.startsWith("0x") ? wallet : "0x" + wallet
    let marketplaceCount = 0
    let dateCount = 0

    // 1. Reclassify moments with lastPurchasePrice but unknown/null acquisition
    const toReclassify = rows.filter(
      (r) => r.lastPurchasePrice != null && r.lastPurchasePrice > 0 && (!r.acquisitionMethod || r.acquisitionMethod === "unknown")
    )

    for (const row of toReclassify) {
      const { error } = await (supabaseAdmin as any)
        .from("moment_acquisitions")
        .update({
          acquisition_method: "marketplace",
          buy_price: row.lastPurchasePrice,
          acquired_date: row.acquiredAt ? new Date(row.acquiredAt).toISOString() : null,
          source: "progressive_classify",
        })
        .eq("nft_id", row.momentId)
        .eq("wallet", walletAddr)
        .eq("acquisition_method", "unknown")
      if (!error) marketplaceCount++
    }

    // 2. Fill in acquired_date where GQL has it but moment_acquisitions does not
    const toDateFill = rows.filter(
      (r) => r.acquiredAt && r.acquisitionMethod && r.acquisitionMethod !== "unknown"
    )

    for (const row of toDateFill) {
      const { error } = await (supabaseAdmin as any)
        .from("moment_acquisitions")
        .update({ acquired_date: new Date(row.acquiredAt!).toISOString() })
        .eq("nft_id", row.momentId)
        .eq("wallet", walletAddr)
        .is("acquired_date", null)
      if (!error) dateCount++
    }

    // 3. Propagate acquiredAt to wallet_moments_cache where missing
    const toCacheFill = rows.filter((r) => r.acquiredAt && r.momentId)
    for (const row of toCacheFill) {
      await (supabaseAdmin as any)
        .from("wallet_moments_cache")
        .update({ acquired_at: row.acquiredAt })
        .eq("moment_id", row.momentId)
        .eq("wallet_address", walletAddr)
        .is("acquired_at", null)
    }

    console.log(`[wallet-search] Progressive classify: ${marketplaceCount} marketplace, ${dateCount} dates updated`)
  } catch (err) {
    // Never let progressive classification crash the response
    console.warn("[wallet-search] Progressive classify error:", err instanceof Error ? err.message : String(err))
  }
}

async function upsertWalletMomentsCache(wallet: string, rows: WalletRow[]) {
  try {
    // Always use the resolved 0x address, never a raw username
    const resolvedAddress = isWalletAddress(wallet) ? wallet : ensureFlowPrefix(wallet)
    const now = new Date().toISOString()
    // wmc's unique constraint is the 3-col (wallet_address, collection_id,
    // moment_id) — there is NO plain (wallet_address, moment_id) index, so a
    // 2-col onConflict raises 42P10 and silently no-ops. collection_id was
    // never on baseRow, so these writes broke when the constraint changed
    // 2026-05-06. Resolve the TS collection id once and key on it. If it can't
    // be resolved, skip the write entirely rather than insert NULL.
    const tsCollectionId = await getCollectionId()
    if (!tsCollectionId) {
      console.warn("[wallet-search] Cache upsert skipped: could not resolve TS collection id")
      return
    }
    const baseRow = (r: WalletRow) => ({
      wallet_address: resolvedAddress,
      collection_id: tsCollectionId,
      moment_id: r.momentId,
      fmv_usd: r.fmv ?? null,
      serial_number: r.serialNumber ?? (r.serial != null ? r.serial : null),
      last_seen_at: now,
      tier: r.tier ?? null,
      acquired_at: r.acquiredAt ?? null,
      player_name: r.playerName ?? null,
      set_name: r.setName ?? null,
      series_number: r.series != null ? Number(r.series) || null : null,
      image_url: r.thumbnailUrl ?? null,
    })

    // May 9 dedup project: prefer canonical UUID-format external_ids over the
    // integer "set:play" keys we synthesize from on-chain metadata. The
    // editions table can host both formats for the same edition; picking the
    // UUID side keeps wmc writes from creating new orphan rows that the
    // wmc_canonicalize trigger has to chase.
    const intKeys = Array.from(new Set(
      rows
        .map(r => r.editionKey)
        .filter((k): k is string => !!k && /^\d+:\d+$/.test(k))
    ))
    const canonicalKeyByInt = new Map<string, string>()
    if (intKeys.length > 0) {
      {
        for (let i = 0; i < intKeys.length; i += 200) {
          const chunk = intKeys.slice(i, i + 200)
          const setPlayPairs = chunk
            .map(k => k.split(":"))
            .filter(p => p.length === 2 && p.every(s => /^\d+$/.test(s)))
            .map(p => ({ set_id_onchain: Number(p[0]), play_id_onchain: Number(p[1]) }))
          if (setPlayPairs.length === 0) continue
          const setIds = Array.from(new Set(setPlayPairs.map(p => p.set_id_onchain)))
          const playIds = Array.from(new Set(setPlayPairs.map(p => p.play_id_onchain)))
          const { data: edRows } = await (supabaseAdmin as any)
            .from("editions")
            .select("external_id, set_id_onchain, play_id_onchain")
            .eq("collection_id", tsCollectionId)
            .in("set_id_onchain", setIds)
            .in("play_id_onchain", playIds)
          for (const row of (edRows ?? [])) {
            if (row.set_id_onchain == null || row.play_id_onchain == null) continue
            const intKey = `${row.set_id_onchain}:${row.play_id_onchain}`
            const isInt = /^\d+:\d+$/.test(String(row.external_id ?? ""))
            const existing = canonicalKeyByInt.get(intKey)
            // Prefer UUID-format external_id; only fall back to int-format
            // when nothing else has been seen yet. Equivalent to:
            //   ORDER BY (external_id ~ '^[0-9]+:[0-9]+$') ASC LIMIT 1
            if (!existing || (!isInt && /^\d+:\d+$/.test(existing))) {
              canonicalKeyByInt.set(intKey, String(row.external_id))
            }
          }
        }
      }
    }
    const resolveEditionKey = (k: string | null | undefined): string | null => {
      if (!k) return null
      const canonical = canonicalKeyByInt.get(k)
      return canonical ?? k
    }

    // Split rows by edition_key availability so that rows that failed to
    // resolve edition_key don't clobber previously-cached edition_key values.
    const resolvedRows = rows
      .filter(r => r.momentId && r.editionKey)
      .map(r => ({ ...baseRow(r), edition_key: resolveEditionKey(r.editionKey) }))
    const unresolvedRows = rows
      .filter(r => r.momentId && !r.editionKey)
      .map(r => baseRow(r))

    const CHUNK = 200
    for (let i = 0; i < resolvedRows.length; i += CHUNK) {
      const chunk = resolvedRows.slice(i, i + CHUNK)
      await (supabaseAdmin as any)
        .from("wallet_moments_cache")
        .upsert(chunk, { onConflict: "wallet_address,collection_id,moment_id" })
    }
    for (let i = 0; i < unresolvedRows.length; i += CHUNK) {
      const chunk = unresolvedRows.slice(i, i + CHUNK)
      await (supabaseAdmin as any)
        .from("wallet_moments_cache")
        .upsert(chunk, { onConflict: "wallet_address,collection_id,moment_id" })
    }
    console.log(`[wallet-search] Cached ${resolvedRows.length + unresolvedRows.length} moments for ${resolvedAddress} (${resolvedRows.length} with edition_key)`)
  } catch (err) {
    console.warn("[wallet-search] Cache upsert failed:", err instanceof Error ? err.message : String(err))
  }
}

const walletSearchSchema = z.object({
  input: z.string().min(1, "Please enter a wallet address or username.").transform(s => s.trim()),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(60).default(24),
  collection: z.string().optional(),
  // Phase 2 alias — callers can send either collection or collectionId.
  collectionId: z.string().optional(),
  // NBA/WNBA filter — only honored for Top Shot. Silently ignored for any
  // other collection because league has no meaning there. Backed by
  // wallet_moments_cache.league (NBA, WNBA, or NULL).
  league: z.enum(["NBA", "WNBA"]).optional(),
})

export async function POST(req: NextRequest) {
  // topLevelStage is updated as the handler progresses through phases so the
  // top-level catch can pin the failure to a specific stage instead of
  // emitting a generic "[wallet-search] error" line that Vercel truncates
  // before the cause is visible.
  let topLevelStage:
    | "parse_body"
    | "validate"
    | "resolve_wallet"
    | "fetch_owned_ids"
    | "enrich_moments"
    | "fmv_enrich"
    | "acquisition_enrich"
    | "respond"
    = "parse_body"
  let resolvedInput: string | null = null
  try {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      console.log("[wallet-search] malformed JSON in request body")
      return NextResponse.json(
        {
          error: "Malformed JSON in request body.",
          rows: [],
          summary: { totalMoments: 0, returnedMoments: 0, remainingMoments: 0 },
        } satisfies WalletSearchResponse,
        { status: 400 }
      )
    }
    topLevelStage = "validate"

    if (!body || typeof body !== "object" || !("input" in body) || !(body as any).input || String((body as any).input).trim() === "") {
      console.log("[wallet-search] missing or empty input field")
      return NextResponse.json(
        {
          error: "input is required",
          rows: [],
          summary: { totalMoments: 0, returnedMoments: 0, remainingMoments: 0 },
        } satisfies WalletSearchResponse,
        { status: 400 }
      )
    }

    const parsed = walletSearchSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: parsed.error.issues[0]?.message ?? "Invalid request.",
          rows: [],
          summary: { totalMoments: 0, returnedMoments: 0, remainingMoments: 0 },
        } satisfies WalletSearchResponse,
        { status: 400 }
      )
    }

    const { input, offset, limit, league } = parsed.data
    resolvedInput = input

    // Soft-recognize Flow EVM addresses (40-hex 0x...) so Beezie-style EVM
    // wallets don't surface as "Username not found" errors. The structure is
    // valid, just not yet supported — Phase 1 of Flow EVM scaffolding ships
    // the detection branch only. Status 200 mirrors the existing
    // rows:[] + error string contract so the UI's error renderer fires
    // unchanged without a 4xx redirect.
    if (detectAddressChain(input) === "evm") {
      return NextResponse.json(
        {
          rows: [],
          summary: { totalMoments: 0, returnedMoments: 0, remainingMoments: 0 },
          error: "Flow EVM wallets are not yet supported in RPC. Beezie and other Flow EVM collections are coming soon.",
        } satisfies WalletSearchResponse,
        { status: 200 }
      )
    }

    // Phase 2: collectionId takes precedence over the legacy collection alias.
    const collection = parsed.data.collectionId ?? parsed.data.collection
    const isAllDay = collection === "nfl-all-day"
    // league is only meaningful for Top Shot. For other collections wmc.league
    // is NULL and the filter would produce 0 rows — silently drop instead.
    const isTopShot = !collection || collection === "nba-top-shot"
    const effectiveLeague = isTopShot ? (league ?? null) : null

    // Collections with their own dedicated wallet routes shouldn't flow
    // through here — the response shapes differ. Return an informative
    // error that tells the UI which route to use instead. (This keeps
    // wallet-search focused on Top Shot + AllDay without introducing
    // shape drift for Pinnacle / Golazos / UFC.)
    if (collection === "disney-pinnacle") {
      return NextResponse.json(
        {
          rows: [],
          summary: { totalMoments: 0, returnedMoments: 0, remainingMoments: 0 },
          error: "Use /api/pinnacle-wallet for Disney Pinnacle wallet lookups.",
          redirect: "/api/pinnacle-wallet",
        } satisfies WalletSearchResponse & { redirect?: string },
        { status: 400 }
      )
    }
    if (collection === "ufc") {
      return NextResponse.json(
        {
          rows: [],
          summary: { totalMoments: 0, returnedMoments: 0, remainingMoments: 0 },
          error: "Use /api/ufc-wallet-scan for UFC Strike wallet scans.",
          redirect: "/api/ufc-wallet-scan",
        } satisfies WalletSearchResponse & { redirect?: string },
        { status: 400 }
      )
    }
    if (collection === "laliga-golazos") {
      // Golazos wallet lookups are not yet indexed server-side — the
      // Flowty-only listing pipeline doesn't populate wallet_moments_cache
      // with golazos rows. Return an empty-but-valid response so the UI
      // can render a graceful "limited support" state.
      return NextResponse.json(
        {
          rows: [],
          summary: { totalMoments: 0, returnedMoments: 0, remainingMoments: 0 },
          error: "Golazos wallet analysis is coming soon. Floor and FMV data are live on the sniper and overview pages.",
        } satisfies WalletSearchResponse,
        { status: 200 }
      )
    }

    let wallet: string
    let ids: number[]
    try {
      topLevelStage = "resolve_wallet"
      wallet = await resolveWalletFromInput(input)
      topLevelStage = "fetch_owned_ids"
      ids = isAllDay ? await getAllDayOwnedIds(wallet) : await getOwnedMomentIds(wallet)
    } catch (err) {
      console.error("[wallet-search] Failed to resolve wallet or fetch owned IDs:", err instanceof Error ? err.message : String(err))
      return NextResponse.json(
        {
          error: "Failed to fetch wallet data. Please try again.",
          rows: [],
          summary: { totalMoments: 0, returnedMoments: 0, remainingMoments: 0 },
        } satisfies WalletSearchResponse,
        { status: 500 }
      )
    }

    // Rewards: a logged-in user scouting a collector wallet earns scout_wallet
    // (daily_cap 5). Session-resolved + best-effort; this route is public, so
    // anon lookups (no session) are simply skipped. Never block the lookup.
    try {
      const scout = await getCurrentUser()
      if (scout) await awardPoints(scout.id, "scout_wallet")
    } catch { /* rewards must never break wallet-search */ }

    // League filter for Top Shot: intersect on-chain owned ids with wmc rows
    // for this wallet+collection where league matches. wmc is upserted by this
    // very route on every successful walk so coverage is high; if a moment is
    // unindexed we drop it from the filtered view (the "all" view always
    // includes it). Skipped entirely when the wmc lookup errors so a transient
    // DB blip doesn't show a false-empty wallet.
    if (effectiveLeague) {
      try {
        const tsCollectionId = await getCollectionId()
        if (tsCollectionId) {
          const walletAddr = wallet.startsWith("0x") ? wallet : "0x" + wallet
          const { data: leagueIds, error: leagueErr } = await (supabaseAdmin as any)
            .from("wallet_moments_cache")
            .select("moment_id")
            .eq("wallet_address", walletAddr)
            .eq("collection_id", tsCollectionId)
            .eq("league", effectiveLeague)
            .limit(10000)
          if (!leagueErr && Array.isArray(leagueIds)) {
            const allowed = new Set<string>(leagueIds.map((r: any) => String(r.moment_id)))
            ids = ids.filter((id) => allowed.has(String(id)))
          } else if (leagueErr) {
            console.warn("[wallet-search] league filter wmc lookup failed:", leagueErr.message)
          }
        }
      } catch (err) {
        console.warn("[wallet-search] league filter threw:", err instanceof Error ? err.message : String(err))
      }
    }

    const slice = ids.slice(offset, offset + limit)
    topLevelStage = "enrich_moments"

    const baseRows = (await mapWithConcurrency(slice, 8, async (id) => {
      // INVARIANT_SAFE: catch per-moment errors so one bad moment doesn't crash the whole wallet
      // `stage` tracks which sub-step failed so Vercel logs can identify
      // whether GQL, Flow metadata, or row assembly blew up.
      let stage: "enrich-gql" | "flow-metadata" | "assemble" = "enrich-gql"
      try {
      const [gql, meta] = await Promise.all([
        fetchMomentGraphQL(String(id)).catch((e) => { stage = "enrich-gql"; throw e }),
        getMomentMetadata(wallet, id).catch((e) => { stage = "flow-metadata"; throw e }),
      ])
      stage = "assemble"

      const serial = toNum(meta.serial)
      const mint = toNum(meta.mint)
      const setId = toNum(meta.setID) ?? toNum(gql.setID)
      const playId = toNum(meta.playID) ?? toNum(gql.playID)
      const editionKey = setId !== null && playId !== null ? `${setId}:${playId}` : null
      const normalizedSet = normalizeSetName(meta.setName ?? "Unknown Set")
      const normalizedParallel = normalizeParallel("")
      const graphqlBadgeTypes = gql.badges.map((b) => b.type).filter(Boolean)

      return {
        momentId: String(id),
        playerName: meta.player ?? "Unknown Player",
        team: meta.team ?? undefined,
        league: gql.league ?? undefined,
        setName: normalizedSet,
        series: meta.series ?? undefined,
        tier: gql.tier ?? undefined,
        serial: serial ?? undefined,
        mintSize: mint ?? undefined,
        serialNumber: serial ?? null,
        circulationCount: mint ?? null,
        officialBadges: graphqlBadgeTypes,
        specialSerialTraits: specialSerialTraits(serial, mint, graphqlBadgeTypes),
        isLocked: gql.isLocked,
        bestAsk: gql.bestAsk,
        lowAsk: gql.lowAsk,
        bestOffer: gql.bestOffer,
        lastPurchasePrice: gql.lastPurchasePrice,
        acquiredAt: gql.acquiredAt,
        editionKey,
        parallel: normalizedParallel,
        subedition: normalizedParallel,
        flowId: gql.flowId,
        thumbnailUrl: buildThumbnailUrl(gql.flowId),
        tssPoints: gql.tssPoints,
      } as WalletRow
      } catch (momentErr: any) {
        const reason = ((momentErr?.message ?? "unknown") as string).slice(0, 80)
        const walletShort = wallet ? wallet.slice(0, 10) : "none"
        console.warn(
          `[wallet-search] moment-fail momentId=${id} ` +
            `wallet=${walletShort} ` +
            `stage=${stage} ` +
            `reason=${reason}`
        );
        const [meta, gqlFallback] = await Promise.all([
          getMomentMetadata(wallet, id).catch(function() { return {} as Record<string,string>; }),
          fetchMomentGraphQL(String(id)).catch(function() {
            return { flowId: null, setID: null, playID: null } as any;
          }),
        ]);
        const setIdFb = toNum(meta.setID) ?? toNum(gqlFallback.setID);
        const playIdFb = toNum(meta.playID) ?? toNum(gqlFallback.playID);
        const editionKeyFb = setIdFb !== null && playIdFb !== null ? `${setIdFb}:${playIdFb}` : null;
        return {
          momentId: String(id),
          playerName: meta.player || "Unknown (error loading)",
          team: meta.team || undefined,
          setName: meta.setName || "Unknown Set",
          series: meta.series || undefined,
          serial: toNum(meta.serial) ?? undefined,
          mintSize: toNum(meta.mint) ?? undefined,
          serialNumber: toNum(meta.serial) ?? null,
          circulationCount: toNum(meta.mint) ?? null,
          officialBadges: [],
          specialSerialTraits: [],
          isLocked: false,
          bestAsk: null,
          lowAsk: null,
          bestOffer: null,
          lastPurchasePrice: null,
          acquiredAt: null,
          editionKey: editionKeyFb,
          parallel: null,
          subedition: null,
          flowId: gqlFallback.flowId ?? null,
          thumbnailUrl: null,
          tssPoints: null,
        } as WalletRow;
      }
    }))

    const editionCounts = new Map<string, { owned: number; locked: number }>()
    for (const row of baseRows) {
      const key = buildEditionScopeKey({
        editionKey: row.editionKey,
        setName: row.setName,
        playerName: row.playerName,
        parallel: row.parallel,
        subedition: row.subedition,
      })
      const current = editionCounts.get(key) ?? { owned: 0, locked: 0 }
      current.owned += 1
      if (row.isLocked) current.locked += 1
      editionCounts.set(key, current)
    }

    const rowsWithCounts = baseRows.map((row) => {
      const key = buildEditionScopeKey({
        editionKey: row.editionKey,
        setName: row.setName,
        playerName: row.playerName,
        parallel: row.parallel,
        subedition: row.subedition,
      })
      const counts = editionCounts.get(key) ?? { owned: 1, locked: row.isLocked ? 1 : 0 }
      return { ...row, editionsOwned: counts.owned, editionsLocked: counts.locked }
    })

    // Batch-enrich FMV from fmv_snapshots + low ask from cached_listings
    topLevelStage = "fmv_enrich"
    const fmvEnriched = await batchEnrichFmvAndAsks(rowsWithCounts)

    // Enrich with acquisition method data
    topLevelStage = "acquisition_enrich"
    const rows = await enrichWithAcquisitionData(fmvEnriched, wallet)

    // Fire-and-forget — progressively reclassify unknown acquisitions
    progressivelyClassify(rows, wallet)

    const totalTssPoints = rows.reduce(function(sum, r) {
      return sum + (r.tssPoints ?? 0)
    }, 0)

    // Fire-and-forget — seeds all editions regardless of price
    getCollectionId().then((collectionId) => {
      if (collectionId) seedEditionsToSupabase(rows, collectionId).catch(() => {})
    })

    // Fire-and-forget — upsert wallet moments into cache for fallback
    upsertWalletMomentsCache(wallet, rows).catch(() => {})

    // Fire-and-forget — persist cost basis from wallet-search purchase data
    const acquisitionRows = baseRows
      .filter((r: WalletRow) => r.lastPurchasePrice && r.lastPurchasePrice > 0 && r.flowId)
      .map((r: WalletRow) => ({
        nft_id: r.flowId as string,
        wallet: wallet.startsWith("0x") ? wallet : "0x" + wallet,
        buy_price: r.lastPurchasePrice as number,
        acquired_date: r.acquiredAt || new Date().toISOString(),
        acquired_type: 1,
        fmv_at_acquisition: (r as any).fmv ?? null,
        transaction_hash: "ws:" + r.flowId,
        source: "wallet_search",
      }))
    if (acquisitionRows.length > 0) {
      ;(supabaseAdmin as any)
        .from("moment_acquisitions")
        .upsert(acquisitionRows, { onConflict: "nft_id,wallet,transaction_hash", ignoreDuplicates: true })
        .then(({ error }: { error: any }) => {
          if (error && !String(error.message ?? "").includes("duplicate")) {
            console.warn("[wallet-search] Cost basis write error:", error.message)
          }
        })
    }

    // Second pass — fill in cost basis from the sales table for moments that
    // did not carry a lastPurchasePrice on the GQL response. The most recent
    // sale of an nft_id is, by definition, the buy that put the moment into
    // the current owner's collection.
    const missingCostBasis = baseRows
      .filter((r: WalletRow) => r.flowId && (!r.lastPurchasePrice || r.lastPurchasePrice <= 0))
      .map((r: WalletRow) => r.flowId as string)
      .filter(Boolean)

    if (missingCostBasis.length > 0) {
      ;(async () => {
        try {
          const { data: salesRows } = await (supabaseAdmin as any)
            .from("sales")
            .select("nft_id, price_usd, sold_at, seller_address, transaction_hash")
            .in("nft_id", missingCostBasis.slice(0, 200))
            .gt("price_usd", 0)
            .order("sold_at", { ascending: false })

          if (!salesRows || salesRows.length === 0) return

          const latestSaleByNft = new Map<string, any>()
          for (const row of salesRows) {
            if (!latestSaleByNft.has(row.nft_id)) latestSaleByNft.set(row.nft_id, row)
          }

          const walletAddr = wallet.startsWith("0x") ? wallet : "0x" + wallet
          const salesAcquisitions = Array.from(latestSaleByNft.entries()).map(([nftId, sale]) => ({
            nft_id: nftId,
            wallet: walletAddr,
            buy_price: sale.price_usd,
            acquired_date: sale.sold_at,
            acquired_type: 1,
            fmv_at_acquisition: null,
            seller_address: sale.seller_address ?? null,
            transaction_hash: sale.transaction_hash ?? "backfill:" + nftId,
            source: "sales_backfill",
          }))

          if (salesAcquisitions.length === 0) return

          const { error } = await (supabaseAdmin as any)
            .from("moment_acquisitions")
            .upsert(salesAcquisitions, { onConflict: "nft_id,wallet,transaction_hash", ignoreDuplicates: true })

          if (error && !String(error.message ?? "").includes("duplicate")) {
            console.warn("[wallet-search] Sales backfill write error:", error.message)
          } else {
            console.log("[wallet-search] Sales backfill: wrote " + salesAcquisitions.length + " acquisitions")
          }
        } catch (e) {
          console.warn("[wallet-search] Sales backfill exception:", e instanceof Error ? e.message : String(e))
        }
      })()
    }

    // Acquisition stats (non-blocking — fail silently if missing)
    let acquisitionStats: AcquisitionStats | null = null
    try {
      const walletAddrForStats = wallet.startsWith("0x") ? wallet : "0x" + wallet
      const acqParams: Record<string, any> = { p_wallet: walletAddrForStats }
      const collectionUuid = await getCollectionIdForSlug(collection)
      if (collectionUuid) acqParams.p_collection_id = collectionUuid
      const { data: acqRaw, error: acqErr } = await (supabaseAdmin as any).rpc("get_acquisition_stats", acqParams)
      if (!acqErr && acqRaw) {
        const result = (Array.isArray(acqRaw) ? acqRaw[0] : acqRaw) as { breakdown?: Array<{ method: string; count: number; total_spent?: number }>; total_moments?: number; total_spent?: number; locked_count?: number }
        const counts: Record<string, number> = { pack_pull: 0, marketplace: 0, challenge_reward: 0, gift: 0 }
        for (const b of result?.breakdown ?? []) {
          if (b?.method && counts[b.method] !== undefined) counts[b.method] = Number(b.count) || 0
        }
        acquisitionStats = {
          pack_pull_count: counts.pack_pull,
          marketplace_count: counts.marketplace,
          challenge_reward_count: counts.challenge_reward,
          gift_count: counts.gift,
          total_count: Number(result?.total_moments ?? 0),
          locked_count: Number(result?.locked_count ?? 0),
          total_spent: Number(result?.total_spent ?? 0),
        }
      }
    } catch (err) {
      console.log("[wallet-search] acquisition-stats lookup failed:", err instanceof Error ? err.message : String(err))
    }

    topLevelStage = "respond"
    return NextResponse.json({
      rows,
      walletAddress: wallet,
      summary: {
        totalMoments: ids.length,
        returnedMoments: rows.length,
        remainingMoments: Math.max(0, ids.length - (offset + rows.length)),
        totalTssPoints,
      },
      acquisitionStats,
    } satisfies WalletSearchResponse)
  } catch (e) {
    const message = cleanErrorMessage(e)
    // Structured single-line log so a single Vercel-dashboard grep tells the
    // whole story next time wallet-search 500s. Vercel truncates after ~50
    // chars on filtered searches; keeping it on one console.log line means
    // the headline carries stage + input + cause.
    try {
      const errCode =
        (e && typeof e === "object" && "code" in (e as any) ? String((e as any).code) : null) ??
        (e instanceof Error && (e as any).cause && typeof (e as any).cause === "object" && "code" in ((e as any).cause)
          ? String(((e as any).cause as any).code)
          : null)
      const errName = e instanceof Error ? e.name : null
      const rawMsg = e instanceof Error ? e.message : String(e)
      console.log(
        "[wallet-search] error " +
          JSON.stringify({
            stage: topLevelStage,
            input: resolvedInput,
            error_message: rawMsg.slice(0, 240),
            error_code: errCode,
            error_name: errName,
          })
      )
    } catch { /* logging is best-effort */ }
    return NextResponse.json(
      {
        rows: [],
        summary: { totalMoments: 0, returnedMoments: 0, remainingMoments: 0 },
        error: message,
      } satisfies WalletSearchResponse,
      { status: 500 }
    )
  }
}