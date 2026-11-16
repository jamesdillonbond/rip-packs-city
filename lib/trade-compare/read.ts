// lib/trade-compare/read.ts
//
// The I/O half of /trades/compare: candidates from the DB, then the CHAIN for every candidate
// (held + locked; listed for sale) and each wallet's on-chain count. Pure logic lives in
// ./compare.ts. Every read here THROWS on failure — the route turns that into a 503; a failed
// chain read is never shown as "nothing to trade" or as "tradeable".
//
// 2026-11-16 (afternoon): per COLLECTION — Top Shot, All Day, Golazos. One Dapper wallet holds all
// three, so a Top Shot username names the wallet for each.
//   · held/locked: Top Shot reads its locking contract (readTopShotHoldings); All Day and Golazos
//     have no locking contract on chain — the trade room's own reader (holdingsReader) answers held.
//     ⚠ All Day's LOCKED Moments are Dapper-custodied and invisible on chain, so one reads as not
//     held: it is never offered, which is right (it cannot move), and the page words it so.
//   · listed: Top Shot from its marketplace contract (readTopShotListed); All Day / Golazos from
//     RPC's listings index (cached_listings_v2, open rows by seller). That index is not a census
//     (#149) — here it only EXCLUDES, so a miss offers a Moment whose listing must be cancelled
//     first; the trade room's own pick check is the same.

import type { SupabaseClient } from "@supabase/supabase-js"
import { readTopShotHoldings, type Holding } from "@/lib/giveaways/topshot-holdings"
import { readTopShotListed } from "@/lib/trade-room/topshot-listed"
import { holdingsReader } from "@/lib/trade-room/multi-plan"
import { readCollectionCount } from "@/lib/chains/flow/wmc-empty-proof"
import { swapCollection, type SwapCollection } from "@/lib/trade-room/multi-swap-cadence"
import type { CandidateRow, ChainState } from "./compare"

/** Rows per side the DB returns (highest FMV first); *_total says how many exist. */
export const CANDIDATE_LIMIT = 600
/** Candidate ids per chain call; chunks run 4 at a time. */
const CHAIN_CHUNK = 50
const CHAIN_PARALLEL = 4

/** The collections Compare covers. UFC's Flow market is closed, so it is not offered. */
export const COMPARE_SLUGS = ["nba-top-shot", "nfl-all-day", "laliga-golazos"] as const
export type CompareSlug = (typeof COMPARE_SLUGS)[number]

export function compareCollection(slug: string | null | undefined): SwapCollection | null {
  if (!slug || !(COMPARE_SLUGS as readonly string[]).includes(slug)) return null
  return swapCollection(slug)
}

export interface RawCompare {
  a_indexed: number
  b_indexed: number
  a_total: number
  b_total: number
  a_rows: CandidateRow[]
  b_rows: CandidateRow[]
}

export async function readCandidates(db: SupabaseClient, collectionId: string, a: string, b: string, limit = CANDIDATE_LIMIT): Promise<RawCompare> {
  const { data, error } = await db.rpc("get_trade_compare", { p_collection_id: collectionId, p_a: a, p_b: b, p_limit: limit })
  if (error) throw new Error(`get_trade_compare: ${error.message}`)
  const d = data as Partial<RawCompare> | null
  if (!d || !Array.isArray(d.a_rows) || !Array.isArray(d.b_rows)) throw new Error("get_trade_compare: unexpected shape")
  const n = (v: unknown) => {
    const x = Number(v)
    if (!Number.isFinite(x) || x < 0) throw new Error("get_trade_compare: bad count")
    return x
  }
  return {
    a_indexed: n(d.a_indexed),
    b_indexed: n(d.b_indexed),
    a_total: n(d.a_total),
    b_total: n(d.b_total),
    a_rows: d.a_rows as CandidateRow[],
    b_rows: d.b_rows as CandidateRow[],
  }
}

type HoldingsReader = (address: string, ids: string[]) => Promise<Record<string, Holding>>

/** Held + locked for every id, in parallel chunks. Throws if any chunk fails. */
export async function readHoldingsParallel(address: string, ids: readonly string[], read: HoldingsReader = readTopShotHoldings): Promise<Record<string, Holding>> {
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += CHAIN_CHUNK) chunks.push(ids.slice(i, i + CHAIN_CHUNK))
  const out: Record<string, Holding> = {}
  for (let i = 0; i < chunks.length; i += CHAIN_PARALLEL) {
    const batch = await Promise.all(chunks.slice(i, i + CHAIN_PARALLEL).map((c) => read(address, c)))
    for (const r of batch) Object.assign(out, r)
  }
  return out
}

/** Open listings RPC's index holds for `address` among `ids` (All Day / Golazos). Throws on a failed read. */
export async function readIndexedListed(db: SupabaseClient, collectionId: string, address: string, ids: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>()
  const nums = ids.filter((id) => /^\d{1,19}$/.test(id))
  for (let i = 0; i < nums.length; i += 300) {
    const { data, error } = await db
      .from("cached_listings_v2")
      .select("flow_id, expiry_at")
      .eq("collection_id", collectionId)
      .eq("seller_address", address)
      .is("completed_at", null)
      .in("flow_id", nums.slice(i, i + 300))
      .limit(1000)
    if (error) throw new Error(`cached_listings_v2 read failed: ${error.message}`)
    const now = Date.now()
    for (const r of (data ?? []) as Array<{ flow_id: number | string; expiry_at: string | null }>) {
      if (r.expiry_at && Date.parse(r.expiry_at) <= now) continue
      out.add(String(r.flow_id))
    }
  }
  return out
}

export interface ChainDeps {
  holdings?: HoldingsReader
  listed?: (address: string, ids: readonly string[]) => Promise<Set<string>>
}

/** The chain's answer for one side's candidates in one collection. An empty candidate list reads nothing. */
export async function readChain(db: SupabaseClient, c: SwapCollection, address: string, rows: readonly CandidateRow[], deps: ChainDeps = {}): Promise<ChainState> {
  const ids = rows.map((r) => String(r.moment_id))
  if (ids.length === 0) return { holdings: {}, listed: new Set() }
  const topShot = c.slug === "nba-top-shot"
  const holdings = deps.holdings ?? (topShot ? readTopShotHoldings : holdingsReader(c.slug))
  const listed = deps.listed ?? (topShot ? (a: string) => readTopShotListed(a) : (a: string, i: readonly string[]) => readIndexedListed(db, c.collectionId, a, i))
  const [h, l] = await Promise.all([readHoldingsParallel(address, ids, holdings), listed(address, ids)])
  return { holdings: h, listed: l }
}

// Golazos has no count script in wmc-empty-proof (its callers DELETE on that count, so one is not
// added there for a read-only use); Compare reads the on-chain length itself.
const GOLAZOS_COUNT_SCRIPT = `
import NonFungibleToken from 0x1d7e57aa55817448
access(all) fun main(address: Address): Int {
  let col = getAccount(address).capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(/public/GolazosNFTCollection)
  if col == nil { return -1 }
  return col!.getIDs().length
}`.trim()

const FLOW_REST = "https://rest-mainnet.onflow.org/v1/scripts"

async function readGolazosCount(address: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  try {
    const res = await fetchImpl(FLOW_REST, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script: btoa(GOLAZOS_COUNT_SCRIPT), arguments: [btoa(JSON.stringify({ type: "Address", value: address }))] }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const decoded = JSON.parse(atob((await res.text()).trim().replace(/^"|"$/g, ""))) as { type?: string; value?: string }
    if (decoded?.type !== "Int" || typeof decoded.value !== "string" || !/^-?\d+$/.test(decoded.value)) return null
    const n = Number(decoded.value)
    return n < 0 ? 0 : n
  } catch {
    return null
  }
}

/**
 * The wallet's on-chain count in the collection; null when unreadable (the page says "couldn't
 * confirm"). ⚠ All Day's on-chain count leaves out its Dapper-custodied locked Moments, so the
 * index can hold MORE than the chain shows — that reads as complete, never short.
 */
export async function readOnChainCount(address: string, c: SwapCollection, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  if (c.slug === "laliga-golazos") return readGolazosCount(address, fetchImpl)
  return readCollectionCount(address, c.dbSlug)
}
