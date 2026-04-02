import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import fcl from "@/lib/flow"
import * as t from "@onflow/types"
import { alldayGraphql } from "@/lib/allday"
import { getOrSetCache } from "@/lib/cache"
import { supabaseAdmin } from "@/lib/supabase"

// ── Types ─────────────────────────────────────────────────────────────────────

type WalletRow = {
  momentId: string
  playerName: string
  team?: string
  setName: string
  season?: string
  tier?: string
  serial?: number
  mintSize?: number
  serialNumber?: number | null
  circulationCount?: number | null
  specialSerialTraits?: string[]
  isLocked?: boolean
  bestAsk?: number | null
  lowAsk?: number | null
  lastPurchasePrice?: number | null
  acquiredAt?: string | null
  editionKey?: string | null
  editionsOwned?: number
  editionsLocked?: number
  flowId?: string | null
  thumbnailUrl?: string | null
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
  }
  error?: string
}

// ── NFL All Day GraphQL types ─────────────────────────────────────────────────

type SearchListingsResponse = {
  searchMomentListings?: {
    data?: {
      searchSummary?: {
        data?: Array<{
          data?: Array<{
            id?: string
            flowRetailPrice?: { value?: string }
            moment?: {
              id?: string
              tier?: string
              playerName?: string
              teamName?: string
              setName?: string
              season?: string
              serialNumber?: number
              circulationCount?: number
              editionID?: string
              storefrontListingID?: string
              sellerAddress?: string
              tags?: Array<{ id?: string; title?: string }>
            }
          }>
        }>
      }
    }
  }
}

// ── Cache TTLs ────────────────────────────────────────────────────────────────

const OWNED_IDS_TTL = 1000 * 60 * 10
const METADATA_TTL = 1000 * 60 * 30
const GQL_LISTING_TTL = 1000 * 60 * 10

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  if (normalized.includes("rare")) return "Rare"
  if (normalized.includes("legendary")) return "Legendary"
  if (normalized.includes("ultimate")) return "Ultimate"
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function specialSerialTraits(
  serial: number | null,
  mint: number | null
): string[] {
  const out: string[] = []
  if (serial === 1) out.push("#1 Serial")
  if (serial !== null && mint !== null && mint > 0 && serial === mint) {
    out.push("Last Serial")
  }
  return out
}

function buildThumbnailUrl(editionID: string | null) {
  if (!editionID) return null
  return `https://media.nflallday.com/editions/${editionID}/media/image?width=150&format=webp`
}

function cleanErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)

  if (raw.includes("<html") || raw.includes("<title>") || raw.includes("<!DOCTYPE")) {
    if (raw.toLowerCase().includes("slow down") || raw.includes("429") || raw.toLowerCase().includes("too many request")) {
      return "NFL All Day is rate limiting requests right now. Wait 30\u201360 seconds and try again."
    }
    if (raw.toLowerCase().includes("error") || raw.toLowerCase().includes("unavailable")) {
      return "NFL All Day is temporarily unavailable. Try again in a moment."
    }
    return "NFL All Day returned an unexpected response. Try again in a moment."
  }

  if (raw.includes("429") || raw.toLowerCase().includes("too many request") || raw.toLowerCase().includes("rate limit")) {
    return "NFL All Day is rate limiting requests right now. Wait 30\u201360 seconds and try again."
  }

  if (raw.toLowerCase().includes("no collection") || raw.toLowerCase().includes("no nft")) {
    return "This wallet has no All Day moments."
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

// ── Flow on-chain queries ─────────────────────────────────────────────────────

async function getOwnedMomentIds(wallet: string): Promise<number[]> {
  return getOrSetCache(`allday:owned:${wallet}`, OWNED_IDS_TTL, async () => {
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
  return getOrSetCache(`allday:metadata:${wallet}:${id}`, METADATA_TTL, async () => {
    const cadence = `
      import AllDay from 0xe4cf4bdc1751c65d
      access(all)
      fun main(address: Address, id: UInt64): {String:String} {
        let acct = getAccount(address)
        let col = acct.capabilities.borrow<&{AllDay.MomentNFTCollectionPublic}>(/public/AllDayNFTCollection)
          ?? panic("no collection")
        let nft = col.borrowMomentNFT(id: id) ?? panic("no nft")
        let editionID = nft.editionID
        return {
          "editionID": editionID.toString(),
          "serialNumber": nft.serialNumber.toString(),
          "id": nft.id.toString()
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

// ── GraphQL enrichment ────────────────────────────────────────────────────────
// NFL All Day exposes listing data via searchMomentListings.
// We use it to pull tier, playerName, teamName, setName, season, etc.

async function fetchMomentListing(editionID: string) {
  return getOrSetCache(`allday:gql-listing:${editionID}`, GQL_LISTING_TTL, async () => {
    const q = `
      {
        searchMomentListings(input: {
          filters: {
            byEditions: [{ editionID: "${editionID}" }]
          }
          searchInput: { pagination: { cursor: "", direction: RIGHT, count: 1 } }
        }) {
          data {
            searchSummary {
              data {
                ... on MomentListings {
                  data {
                    ... on MomentListing {
                      id
                      flowRetailPrice { value }
                      moment {
                        id tier playerName teamName setName season
                        serialNumber circulationCount editionID
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `
    const d = await withRetry(function() {
      return alldayGraphql<SearchListingsResponse>(q)
    })
    const blocks = d?.searchMomentListings?.data?.searchSummary?.data ?? []
    for (const block of blocks) {
      const listings = block?.data ?? []
      if (listings.length > 0) {
        const listing = listings[0]
        const m = listing?.moment
        const askPrice = listing?.flowRetailPrice?.value
          ? parseFloat(listing.flowRetailPrice.value) / 100_000_000
          : null
        return {
          tier: formatTier(m?.tier ?? null),
          playerName: m?.playerName ?? null,
          teamName: m?.teamName ?? null,
          setName: m?.setName ?? null,
          season: m?.season ?? null,
          circulationCount: m?.circulationCount ?? null,
          bestAsk: askPrice,
          lowAsk: askPrice,
        }
      }
    }
    return {
      tier: null,
      playerName: null,
      teamName: null,
      setName: null,
      season: null,
      circulationCount: null,
      bestAsk: null,
      lowAsk: null,
    }
  })
}

// ── Concurrency helper ────────────────────────────────────────────────────────

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

// ── Supabase seeding ──────────────────────────────────────────────────────────

async function seedEditionsToSupabase(rows: WalletRow[], collectionId: string) {
  for (const row of rows) {
    try {
      if (!row.editionKey) continue

      const tier = row.tier?.toUpperCase() ?? "COMMON"
      const normalizedTier =
        tier.includes("LEGENDARY") ? "LEGENDARY" :
        tier.includes("RARE") ? "RARE" :
        tier.includes("ULTIMATE") ? "ULTIMATE" : "COMMON"

      let playerId: string | null = null
      if (row.playerName && row.playerName !== "Unknown Player") {
        const { data: player } = await supabaseAdmin
          .from("players")
          .upsert(
            {
              external_id: `allday:${row.editionKey.split(":")[1] ?? row.playerName}`,
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
            series: toNum(row.season),
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
          marketplace: "nfl_all_day",
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
      .eq("slug", "nfl_all_day")
      .single()
    return data?.id ?? null
  } catch {
    return null
  }
}

// ── Batch FMV enrichment ──────────────────────────────────────────────────────

async function batchEnrichFmv(rows: WalletRow[]): Promise<WalletRow[]> {
  if (!rows.length) return rows

  try {
    const editionKeys = [...new Set(rows.map(r => r.editionKey).filter(Boolean))] as string[]

    const CHUNK = 50
    const editionChunks: Promise<any>[] = []
    for (let i = 0; i < editionKeys.length; i += CHUNK) {
      editionChunks.push(
        (supabaseAdmin as any)
          .from("editions")
          .select("id, external_id")
          .in("external_id", editionKeys.slice(i, i + CHUNK))
      )
    }

    const editionResults = await Promise.all(editionChunks)

    const extToId = new Map<string, string>()
    for (const { data } of editionResults) {
      for (const row of (data ?? [])) {
        extToId.set(row.external_id, row.id)
      }
    }

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
          if (!fmvMap.has(row.edition_id)) fmvMap.set(row.edition_id, row)
        }
      }
    }

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

    return rows.map(row => {
      const fmvData = row.editionKey ? editionFmvMap.get(row.editionKey) : null
      return {
        ...row,
        fmv: fmvData?.fmv ?? null,
        marketConfidence: fmvData?.confidence ?? null,
        fmvComputedAt: fmvData?.computedAt ?? null,
      }
    })
  } catch (err) {
    console.warn("[allday-wallet-search] FMV enrichment failed:", err instanceof Error ? err.message : String(err))
    return rows
  }
}

// ── Request validation ────────────────────────────────────────────────────────

const walletSearchSchema = z.object({
  input: z.string().min(1, "Please enter a wallet address.").transform(s => s.trim()),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(60).default(24),
})

// ── Route handler ─────────────────────────────────────────────────────────────

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

    const { input, offset, limit } = parsed.data
    const trimmed = input.trim()

    // NFL All Day has no username system — wallet addresses only
    if (!isWalletAddress(trimmed)) {
      return NextResponse.json(
        {
          error: "NFL All Day requires a Flow wallet address (0x followed by 16 hex characters).",
          rows: [],
          summary: { totalMoments: 0, returnedMoments: 0, remainingMoments: 0 },
        } satisfies WalletSearchResponse,
        { status: 400 }
      )
    }

    const wallet = ensureFlowPrefix(trimmed)
    const ids = await getOwnedMomentIds(wallet)
    const slice = ids.slice(offset, offset + limit)

    const baseRows = (await mapWithConcurrency(slice, 8, async (id) => {
      try {
        const meta = await getMomentMetadata(wallet, id)
        const editionID = meta.editionID ?? null
        const serial = toNum(meta.serialNumber)
        const editionKey = editionID ? `allday:${editionID}` : null

        // Enrich via GraphQL listing data
        const gql = editionID ? await fetchMomentListing(editionID) : null

        const playerName = gql?.playerName ?? "Unknown Player"
        const teamName = gql?.teamName ?? undefined
        const setName = gql?.setName ?? "Unknown Set"
        const season = gql?.season ?? undefined
        const tier = gql?.tier ?? undefined
        const circ = gql?.circulationCount ?? null

        return {
          momentId: String(id),
          playerName,
          team: teamName,
          setName,
          season,
          tier,
          serial: serial ?? undefined,
          mintSize: circ ?? undefined,
          serialNumber: serial ?? null,
          circulationCount: circ ?? null,
          specialSerialTraits: specialSerialTraits(serial, circ),
          isLocked: false,
          bestAsk: gql?.bestAsk ?? null,
          lowAsk: gql?.lowAsk ?? null,
          lastPurchasePrice: null,
          acquiredAt: null,
          editionKey,
          flowId: String(id),
          thumbnailUrl: buildThumbnailUrl(editionID),
        } as WalletRow
      } catch (momentErr: any) {
        console.warn("[allday-wallet-search] Moment " + id + " failed: " + (momentErr.message || "unknown").slice(0, 100))
        return {
          momentId: String(id),
          playerName: "Unknown (error loading)",
          setName: "Unknown Set",
          serialNumber: null,
          circulationCount: null,
          specialSerialTraits: [],
          isLocked: false,
          bestAsk: null,
          lowAsk: null,
          lastPurchasePrice: null,
          acquiredAt: null,
          editionKey: null,
          flowId: null,
          thumbnailUrl: null,
        } as WalletRow
      }
    }))

    // Count editions owned per edition key
    const editionCounts = new Map<string, { owned: number; locked: number }>()
    for (const row of baseRows) {
      const key = row.editionKey ?? row.momentId
      const current = editionCounts.get(key) ?? { owned: 0, locked: 0 }
      current.owned += 1
      if (row.isLocked) current.locked += 1
      editionCounts.set(key, current)
    }

    const rowsWithCounts = baseRows.map((row) => {
      const key = row.editionKey ?? row.momentId
      const counts = editionCounts.get(key) ?? { owned: 1, locked: row.isLocked ? 1 : 0 }
      return { ...row, editionsOwned: counts.owned, editionsLocked: counts.locked }
    })

    // Batch-enrich FMV from fmv_snapshots
    const rows = await batchEnrichFmv(rowsWithCounts)

    // Fire-and-forget seeding
    getCollectionId().then((collectionId) => {
      if (collectionId) seedEditionsToSupabase(rows, collectionId).catch(() => {})
    })

    return NextResponse.json({
      rows,
      summary: {
        totalMoments: ids.length,
        returnedMoments: rows.length,
        remainingMoments: Math.max(0, ids.length - (offset + rows.length)),
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
