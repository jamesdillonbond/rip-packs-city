import { NextRequest, NextResponse } from "next/server"
import fcl from "@/lib/flow"
import * as t from "@onflow/types"
import { topshotGraphql } from "@/lib/topshot"
import { getOrSetCache } from "@/lib/cache"
import {
  normalizeParallel,
  normalizeSetName,
  buildEditionScopeKey,
} from "@/lib/wallet-normalize"

type Badge = {
  type: string
  iconSvg: string
}

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
  officialBadges?: string[]
  specialSerialTraits?: string[]
  isLocked?: boolean
  bestAsk?: number | null
  bestOffer?: number | null
  lowAsk?: number | null
  lastPurchasePrice?: number | null
  editionKey?: string | null
  parallel?: string | null
  subedition?: string | null
  editionsOwned?: number
  editionsLocked?: number
  flowId?: string | null
  thumbnailUrl?: string | null
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
      badges?: Array<{
        type?: string | null
        iconSvg?: string | null
      }> | null
      set?: {
        leagues?: Array<string | null> | null
      } | null
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

function specialSerialTraits(serial: number | null, mint: number | null) {
  const out: string[] = []

  if (serial === 1) out.push("#1")
  if (serial !== null && mint !== null && serial === mint) out.push("Perfect Mint")

  return out
}

function buildThumbnailUrl(flowId: string | null) {
  if (!flowId) return null
  return `https://assets.nbatopshot.com/media/${flowId}/image?width=180`
}

async function resolveWalletFromInput(input: string): Promise<string> {
  const trimmed = input.trim()

  if (isWalletAddress(trimmed)) {
    return ensureFlowPrefix(trimmed)
  }

  return getOrSetCache(`username:${trimmed.toLowerCase()}`, USERNAME_TTL, async () => {
    const cleanedUsername = trimmed.replace(/^@+/, "")

    const query = `
      query GetUserProfileByUsername($username: String!) {
        getUserProfileByUsername(input: { username: $username }) {
          publicInfo {
            flowAddress
            username
          }
        }
      }
    `

    const data = await topshotGraphql<UsernameProfileResponse>(query, {
      username: cleanedUsername,
    })

    const rawWallet = data?.getUserProfileByUsername?.publicInfo?.flowAddress ?? null
    const wallet = rawWallet ? ensureFlowPrefix(rawWallet) : null

    if (!wallet) {
      throw new Error("Could not resolve username to wallet address.")
    }

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

        let col = acct
          .capabilities
          .borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)

        if col == nil {
          return []
        }

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

        let nft = col.borrowMoment(id:id)
          ?? panic("no nft")

        let view = nft.resolveView(Type<TopShot.TopShotMomentMetadataView>())
          ?? panic("no metadata")

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
            flowId
            flowSerialNumber
            tier
            forSale
            price
            lastPurchasePrice
            isLocked
            badges {
              type
              iconSvg
            }
            set {
              leagues
            }
          }
        }
      }
    `

    const d = await topshotGraphql<MintedMomentGraphqlData>(q, { id })
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
      league: m?.set?.leagues?.find(Boolean) ?? null,
      badges: Array.isArray(m?.badges)
        ? m.badges.map((b) => ({
            type: b?.type ?? "UNKNOWN",
            iconSvg: b?.iconSvg ?? "",
          }))
        : [],
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
      const currentIndex = nextIndex
      nextIndex += 1

      if (currentIndex >= items.length) return

      results[currentIndex] = await worker(items[currentIndex], currentIndex)
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    () => runWorker()
  )

  await Promise.all(workers)
  return results
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const input = body.input?.trim()
    const offset = Math.max(0, Number(body.offset ?? 0) || 0)
    const limit = Math.min(60, Math.max(1, Number(body.limit ?? 24) || 24))

    if (!input) {
      return NextResponse.json(
        {
          error: "Please enter a wallet address or username.",
          rows: [],
          summary: {
            totalMoments: 0,
            returnedMoments: 0,
            remainingMoments: 0,
          },
        } satisfies WalletSearchResponse,
        { status: 400 }
      )
    }

    const wallet = await resolveWalletFromInput(input)
    const ids = await getOwnedMomentIds(wallet)
    const slice = ids.slice(offset, offset + limit)

    const baseRows = await mapWithConcurrency(slice, 8, async (id) => {
      const [gql, meta] = await Promise.all([
        fetchMomentGraphQL(String(id)),
        getMomentMetadata(wallet, id),
      ])

      const serial = toNum(meta.serial)
      const mint = toNum(meta.mint)
      const setId = toNum(meta.setID)
      const playId = toNum(meta.playID)

      const editionKey =
        setId !== null && playId !== null ? `${setId}:${playId}` : null

      const normalizedSet = normalizeSetName(meta.setName ?? "Unknown Set")
      const normalizedParallel = normalizeParallel("")

      const row: WalletRow = {
        momentId: String(id),
        playerName: meta.player ?? "Unknown Player",
        team: meta.team ?? undefined,
        league: gql.league ?? undefined,
        setName: normalizedSet,
        series: meta.series ?? undefined,
        tier: gql.tier ?? undefined,
        serial: serial ?? undefined,
        mintSize: mint ?? undefined,
        officialBadges: gql.badges.map((b) => b.type).filter(Boolean),
        specialSerialTraits: specialSerialTraits(serial, mint),
        isLocked: gql.isLocked,
        bestAsk: gql.bestAsk,
        lowAsk: gql.lowAsk,
        bestOffer: gql.bestOffer,
        lastPurchasePrice: gql.lastPurchasePrice,
        editionKey,
        parallel: normalizedParallel,
        subedition: normalizedParallel,
        flowId: gql.flowId,
        thumbnailUrl: buildThumbnailUrl(gql.flowId),
      }

      return row
    })

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

    const rows = baseRows.map((row) => {
      const key = buildEditionScopeKey({
        editionKey: row.editionKey,
        setName: row.setName,
        playerName: row.playerName,
        parallel: row.parallel,
        subedition: row.subedition,
      })

      const counts = editionCounts.get(key) ?? {
        owned: 1,
        locked: row.isLocked ? 1 : 0,
      }

      return {
        ...row,
        editionsOwned: counts.owned,
        editionsLocked: counts.locked,
      }
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
    return NextResponse.json(
      {
        rows: [],
        summary: {
          totalMoments: 0,
          returnedMoments: 0,
          remainingMoments: 0,
        },
        error: e instanceof Error ? e.message : "wallet failed",
      } satisfies WalletSearchResponse,
      { status: 500 }
    )
  }
}