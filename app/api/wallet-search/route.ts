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
}

type WalletSearchResponse = {
  rows: WalletRow[]
  summary: {
    totalMoments: number
    returnedMoments: number
    remainingMoments: number
    totalTssPoints?: number
  }
  error?: string
}

type UsernameProfileResponse = {
  getUserProfileByUsername?: {
    publicInfo?: {
      flowAddress?: string | null
      username?: string | null
    } | null
  } | null
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
        leagues?: Array<string | null> | null
      } | null
      play?: { stats?: { jerseyNumber?: string | null } | null } | null
      topshotScore?: { score?: number | null } | null
    } | null
  } | null
}

const USERNAME_TTL = 1000 * 60 * 10
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
  return getOrSetCache(`username:${trimmed.toLowerCase()}`, USERNAME_TTL, async () => {
    const cleanedUsername = trimmed.replace(/^@+/, "")
    const query = `
      query GetUserProfileByUsername($username: String!) {
        getUserProfileByUsername(input: { username: $username }) {
          publicInfo { flowAddress username }
        }
      }
    `
    const data = await withRetry(function() {
      return topshotGraphql<UsernameProfileResponse>(query, { username: cleanedUsername })
    })
    const rawWallet = data?.getUserProfileByUsername?.publicInfo?.flowAddress ?? null
    const wallet = rawWallet ? ensureFlowPrefix(rawWallet) : null
    if (!wallet) throw new Error("Could not resolve username to wallet address.")
    return wallet
  })
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
    const cadence = `
      import TopShot from 0x0b2a3299cc857e29
      import MetadataViews from 0x1d7e57aa55817448
      access(all)
      fun main(address: Address, id: UInt64): {String:String} {
        let acct = getAccount(address)
        let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
          ?? panic("no collection")
        let nft = col.borrowMoment(id:id) ?? panic("no nft")
        let view = nft.resolveView(Type<TopShot.TopShotMomentMetadataView>()) ?? panic("no metadata")
        let data = view as! TopShot.TopShotMomentMetadataView
        return {
          "player": data.fullName ?? "",
          "team": data.teamAtMoment ?? "",
          "setName": data.setName ?? "",
          "series": data.seriesNumber?.toString() ?? "",
          "serial": data.serialNumber.toString(),
          "mint": data.numMomentsInEdition?.toString() ?? "",
          "playID": data.playID.toString(),
          "setID": data.setID.toString()
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
            play { stats { jerseyNumber } }
            set { leagues }
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
            { onConflict: "external_id", ignoreDuplicates: false }
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
          { onConflict: "external_id", ignoreDuplicates: false }
        )
        .select("id")
        .single()

      if (!edition?.id) continue

      if (row.lastPurchasePrice && row.lastPurchasePrice > 0) {
        await supabaseAdmin.from("sales").insert({
          edition_id: edition.id,
          collection_id: collectionId,
          serial_number: row.serial ?? 0,
          price_usd: row.lastPurchasePrice,
          currency: "USD",
          marketplace: "top_shot",
          transaction_hash: `wallet-seed:${row.momentId}`,
          sold_at: new Date().toISOString(),
        })

        await supabaseAdmin.from("fmv_snapshots").insert({
          edition_id: edition.id,
          collection_id: collectionId,
          fmv_usd: row.lastPurchasePrice,
          floor_price_usd: row.lastPurchasePrice,
          confidence: "LOW" as any,
          sales_count_7d: 1,
          algo_version: "wallet-seed-1.0",
        })
      }
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
              { onConflict: "external_id", ignoreDuplicates: true }
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
            .select("edition_id, fmv_usd, confidence, computed_at")
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

    // 7. Build editionKey → FMV data map
    const editionFmvMap = new Map<string, { fmv: number; confidence: string; computedAt: string }>()
    for (const [extId, intId] of extToId) {
      const snap = fmvMap.get(intId)
      if (snap) {
        editionFmvMap.set(extId, {
          fmv: Number(snap.fmv_usd),
          confidence: (snap.confidence ?? "low").toLowerCase(),
          computedAt: snap.computed_at,
        })
      }
    }

    // 8. Apply FMV + ask data to rows
    return rows.map(row => {
      const fmvData = row.editionKey ? editionFmvMap.get(row.editionKey) : null
      const cachedAsk = row.flowId ? askMap.get(row.flowId) : null

      return {
        ...row,
        fmv: fmvData?.fmv ?? null,
        marketConfidence: fmvData?.confidence ?? null,
        fmvComputedAt: fmvData?.computedAt ?? null,
        // Use cached_listings ask if available; keep GQL ask as fallback
        lowAsk: cachedAsk ?? row.lowAsk ?? null,
      }
    })
  } catch (err) {
    console.warn("[wallet-search] FMV/ask enrichment failed:", err instanceof Error ? err.message : String(err))
    return rows
  }
}

const walletSearchSchema = z.object({
  input: z.string().min(1, "Please enter a wallet address or username.").transform(s => s.trim()),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(60).default(24),
  collection: z.string().optional(),
})

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
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

    const { input, offset, limit, collection } = parsed.data
    const isAllDay = collection === "nfl-all-day"

    const wallet = await resolveWalletFromInput(input)
    const ids = isAllDay ? await getAllDayOwnedIds(wallet) : await getOwnedMomentIds(wallet)
    const slice = ids.slice(offset, offset + limit)

    const baseRows = (await mapWithConcurrency(slice, 8, async (id) => {
      // INVARIANT_SAFE: catch per-moment errors so one bad moment doesn't crash the whole wallet
      try {
      const [gql, meta] = await Promise.all([
        fetchMomentGraphQL(String(id)),
        getMomentMetadata(wallet, id),
      ])

      const serial = toNum(meta.serial)
      const mint = toNum(meta.mint)
      const setId = toNum(meta.setID)
      const playId = toNum(meta.playID)
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
        console.warn("[wallet-search] Moment " + id + " failed: " + (momentErr.message || "unknown").slice(0, 100));
        const meta = await getMomentMetadata(wallet, id).catch(function() { return {} as Record<string,string>; });
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
          editionKey: null,
          parallel: null,
          subedition: null,
          flowId: null,
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
    const rows = await batchEnrichFmvAndAsks(rowsWithCounts)

    const totalTssPoints = rows.reduce(function(sum, r) {
      return sum + (r.tssPoints ?? 0)
    }, 0)

    // Fire-and-forget — seeds all editions regardless of price
    getCollectionId().then((collectionId) => {
      if (collectionId) seedEditionsToSupabase(rows, collectionId).catch(() => {})
    })

    return NextResponse.json({
      rows,
      summary: {
        totalMoments: ids.length,
        returnedMoments: rows.length,
        remainingMoments: Math.max(0, ids.length - (offset + rows.length)),
        totalTssPoints,
      },
    } satisfies WalletSearchResponse)
  } catch (e) {
    const message = cleanErrorMessage(e)
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