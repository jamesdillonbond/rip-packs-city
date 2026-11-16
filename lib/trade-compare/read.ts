// lib/trade-compare/read.ts
//
// The I/O half of /trades/compare: candidates from the DB, then the CHAIN for every candidate
// (held + locked, listed) and each wallet's on-chain Moment count. Pure logic lives in
// ./compare.ts. Every read here THROWS on failure — the route turns that into a 503; a failed
// chain read is never shown as "nothing to trade" or as "tradeable".

import type { SupabaseClient } from "@supabase/supabase-js"
import { readTopShotHoldings, type Holding } from "@/lib/giveaways/topshot-holdings"
import { readTopShotListed } from "@/lib/trade-room/topshot-listed"
import { readCollectionCount } from "@/lib/chains/flow/wmc-empty-proof"
import type { CandidateRow, ChainState } from "./compare"

/** Rows per side the DB returns (highest FMV first); *_total says how many exist. */
export const CANDIDATE_LIMIT = 600
/** Candidate ids per chain call (readTopShotHoldings' own chunk is 50; we run chunks in parallel). */
const CHAIN_CHUNK = 50
const CHAIN_PARALLEL = 4

export interface RawCompare {
  a_indexed: number
  b_indexed: number
  a_total: number
  b_total: number
  a_rows: CandidateRow[]
  b_rows: CandidateRow[]
}

export async function readCandidates(db: SupabaseClient, a: string, b: string, limit = CANDIDATE_LIMIT): Promise<RawCompare> {
  const { data, error } = await db.rpc("get_topshot_trade_compare", { p_a: a, p_b: b, p_limit: limit })
  if (error) throw new Error(`get_topshot_trade_compare: ${error.message}`)
  const d = data as Partial<RawCompare> | null
  if (!d || !Array.isArray(d.a_rows) || !Array.isArray(d.b_rows)) throw new Error("get_topshot_trade_compare: unexpected shape")
  const n = (v: unknown) => {
    const x = Number(v)
    if (!Number.isFinite(x) || x < 0) throw new Error("get_topshot_trade_compare: bad count")
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

type HoldingsReader = (address: string, ids: readonly string[]) => Promise<Record<string, Holding>>

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

/** The chain's answer for one side's candidates. An empty candidate list reads nothing. */
export async function readChain(
  address: string,
  rows: readonly CandidateRow[],
  deps: { holdings?: HoldingsReader; listed?: (a: string) => Promise<Set<string>> } = {},
): Promise<ChainState> {
  const ids = rows.map((r) => String(r.moment_id))
  if (ids.length === 0) return { holdings: {}, listed: new Set() }
  const [holdings, listed] = await Promise.all([
    readHoldingsParallel(address, ids, deps.holdings),
    (deps.listed ?? readTopShotListed)(address),
  ])
  return { holdings, listed }
}

/** The wallet's on-chain Top Shot Moment count; null when unreadable (the page says "couldn't check"). */
export async function readOnChainCount(address: string): Promise<number | null> {
  return readCollectionCount(address, "nba_top_shot")
}
