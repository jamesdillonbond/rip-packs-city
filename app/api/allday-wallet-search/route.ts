import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import fcl from "@/lib/flow"
import * as t from "@onflow/types"
import { alldayGraphql } from "@/lib/allday"
import { getOrSetCache } from "@/lib/cache"
import { supabaseAdmin } from "@/lib/supabase"
import { GET_OWNED_MOMENT_IDS, GET_MOMENT_METADATA } from "@/lib/allday-cadence"

// ── Types ────────────────────────────────────────────────────────────────────

type WalletRow = {
  momentId: string
  playerName: string
  team?: string
  setName: string
  series?: string
  tier?: string
  serial?: number
  mintSize?: number
  serialNumber?: number | null
  circulationCount?: number | null
  specialSerialTraits?: string[]
  isLocked?: boolean
  lowAsk?: number | null
  lastPurchasePrice?: number | null
  editionKey?: string | null
  flowId?: string | null
  thumbnailUrl?: string | null
  fmv?: number | null
  marketConfidence?: string | null
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
    } | null
  } | null
}

// ── Constants ────────────────────────────────────────────────────────────────

const USERNAME_TTL = 1000 * 60 * 10
const OWNED_IDS_TTL = 1000 * 60 * 10
const METADATA_TTL = 1000 * 60 * 30
const GQL_MOMENT_TTL = 1000 * 60 * 10

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  if (normalized.includes("premium")) return "Rare"
  if (normalized.includes("legendary")) return "Legendary"
  if (normalized.includes("ultimate")) return "Ultimate"
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function specialSerialTraits(serial: number | null, mint: number | null): string[] {
  const out: string[] = []
  if (serial === 1) out.push("#1 Serial")
  if (serial !== null && mint !== null && mint > 0 && serial === mint) {
    out.push("Last Serial")
  }
  return out
}

function buildThumbnailUrl(flowId: string | null) {
  if (!flowId) return null
  return `https://assets.nflallday.com/media/${flowId}/image?width=180`
}

async function withRetry<T>(fn: () => Promise<T>, delayMs = 2000): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("429") || msg.toLowerCase().includes("too many request")) {
      await new Promise<void>(function(resolve) { setTimeout(resolve, delayMs) })
      return await fn()
    }
    throw err
  }
}

// ── Wallet resolution ────────────────────────────────────────────────────────

async function resolveWalletFromInput(input: string): Promise<string> {
  const trimmed = input.trim()
  if (isWalletAddress(trimmed)) return ensureFlowPrefix(trimmed)
  return getOrSetCache(`allday-username:${trimmed.toLowerCase()}`, USERNAME_TTL, async () => {
    const cleanedUsername = trimmed.replace(/^@+/, "")
    const query = `
      query GetUserProfileByUsername($username: String!) {
        getUserProfileByUsername(input: { username: $username }) {
          publicInfo { flowAddress username }
        }
      }
    `
    const data = await withRetry(function() {
      return alldayGraphql<UsernameProfileResponse>(query, { username: cleanedUsername })
    })
    const rawWallet = data?.getUserProfileByUsername?.publicInfo?.flowAddress ?? null
    const wallet = rawWallet ? ensureFlowPrefix(rawWallet) : null
    if (!wallet) throw new Error("Could not resolve username to wallet address.")
    return wallet
  })
}

// ── On-chain queries ─────────────────────────────────────────────────────────

async function getOwnedMomentIds(wallet: string): Promise<number[]> {
  return getOrSetCache(`allday-owned:${wallet}`, OWNED_IDS_TTL, async () => {
    const result = await fcl.query({
      cadence: GET_OWNED_MOMENT_IDS,
      args: (arg: any) => [arg(wallet, t.Address)],
    })
    return Array.isArray(result) ? (result as number[]) : []
  })
}

async function getMomentMetadata(wallet: string, id: number) {
  return getOrSetCache(`allday-metadata:${wallet}:${id}`, METADATA_TTL, async () => {
    const result = await fcl.query({
      cadence: GET_MOMENT_METADATA,
      args: (arg: any) => [arg(wallet, t.Address), arg(String(id), t.UInt64)],
    })
    return result as Record<string, string>
  })
}

async function fetchMomentGraphQL(id: string) {
  return getOrSetCache(`allday-gql-moment:${id}`, GQL_MOMENT_TTL, async () => {
    const q = `
      query GetMoment($id: ID!) {
        getMintedMoment(momentId: $id) {
          data {
            flowId flowSerialNumber tier forSale price lastPurchasePrice isLocked createdAt
          }
        }
      }
    `
    const d = await withRetry(function() {
      return alldayGraphql<MintedMomentGraphqlData>(q, { id })
    })
    const m = d?.getMintedMoment?.data
    return {
      flowId: m?.flowId ?? null,
      serial: toNum(m?.flowSerialNumber),
      tier: formatTier(m?.tier ?? null),
      lowAsk: m?.forSale ? toNum(m?.price) : null,
      lastPurchasePrice: toNum(m?.lastPurchasePrice),
      isLocked: !!m?.isLocked,
      acquiredAt: m?.createdAt ?? null,
    }
  })
}

// ── Concurrency ──────────────────────────────────────────────────────────────

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex++
      if (currentIndex >= items.length) return
      results[currentIndex] = await worker(items[currentIndex])
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => runWorker())
  )
  return results
}

// ── FMV enrichment ───────────────────────────────────────────────────────────

async function batchEnrichFmv(rows: WalletRow[]): Promise<WalletRow[]> {
  if (!rows.length) return rows

  try {
    const editionKeys = [...new Set(rows.map(r => r.editionKey).filter(Boolean))] as string[]
    if (!editionKeys.length) return rows

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
    const fmvMap = new Map<string, { fmv_usd: number; confidence: string }>()

    if (internalIds.length) {
      const fmvChunks: Promise<any>[] = []
      for (let i = 0; i < internalIds.length; i += CHUNK) {
        fmvChunks.push(
          (supabaseAdmin as any)
            .from("fmv_snapshots")
            .select("edition_id, fmv_usd, confidence")
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

    const editionFmvMap = new Map<string, { fmv: number; confidence: string }>()
    for (const [extId, intId] of extToId) {
      const snap = fmvMap.get(intId)
      if (snap) {
        editionFmvMap.set(extId, {
          fmv: Number(snap.fmv_usd),
          confidence: (snap.confidence ?? "low").toLowerCase(),
        })
      }
    }

    return rows.map(row => {
      const fmvData = row.editionKey ? editionFmvMap.get(row.editionKey) : null
      return {
        ...row,
        fmv: fmvData?.fmv ?? null,
        marketConfidence: fmvData?.confidence ?? null,
      }
    })
  } catch (err) {
    console.warn("[allday-wallet-search] FMV enrichment failed:", err instanceof Error ? err.message : String(err))
    return rows
  }
}

// ── Route handler ────────────────────────────────────────────────────────────

const walletSearchSchema = z.object({
  input: z.string().min(1, "Please enter a wallet address or username.").transform(s => s.trim()),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(60).default(24),
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

    const { input, offset, limit } = parsed.data

    const wallet = await resolveWalletFromInput(input)
    const ids = await getOwnedMomentIds(wallet)
    const slice = ids.slice(offset, offset + limit)

    const baseRows = await mapWithConcurrency(slice, 8, async (id) => {
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

        return {
          momentId: String(id),
          playerName: meta.player ?? "Unknown Player",
          team: meta.team ?? undefined,
          setName: meta.setName ?? "Unknown Set",
          series: meta.series ?? undefined,
          tier: gql.tier ?? meta.tier ?? undefined,
          serial: serial ?? undefined,
          mintSize: mint ?? undefined,
          serialNumber: serial ?? null,
          circulationCount: mint ?? null,
          specialSerialTraits: specialSerialTraits(serial, mint),
          isLocked: gql.isLocked,
          lowAsk: gql.lowAsk,
          lastPurchasePrice: gql.lastPurchasePrice,
          editionKey,
          flowId: gql.flowId,
          thumbnailUrl: buildThumbnailUrl(gql.flowId),
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
          lowAsk: null,
          lastPurchasePrice: null,
          editionKey: null,
          flowId: null,
          thumbnailUrl: null,
        } as WalletRow
      }
    })

    // Batch-enrich FMV from fmv_snapshots
    const rows = await batchEnrichFmv(baseRows)

    return NextResponse.json({
      rows,
      summary: {
        totalMoments: ids.length,
        returnedMoments: rows.length,
        remainingMoments: Math.max(0, ids.length - (offset + rows.length)),
      },
    } satisfies WalletSearchResponse)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
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
