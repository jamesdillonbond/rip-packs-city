// lib/trade-compare/run.ts
//
// One whole compare, shared by GET /api/public/trades/compare (the page) and the concierge's
// compare_collections tool (2026-11-16 evening). Moved out of the route unchanged in behaviour:
// resolve both names → candidates from the index → the chain for every candidate → sides, coverage,
// Quick Trade. The ROUTE keeps its own rate limiting, budget and HTTP shapes; the caller decides
// whether a short index dispatches a walk (`onShortIndex`).
//
// Outcomes are typed, never collapsed: ok · not_found (by name) · same_wallet. A failed lookup or
// chain read THROWS UpstreamError (transient, retryable); anything else throws as itself.
// No wallet address is in the result; FMV confidence tiers never leave the server.

import type { SupabaseClient } from "@supabase/supabase-js"
import { isWalletAddress, resolveTopShotUsernameCacheAware } from "@/lib/chains/flow/topshot-username-resolve"
import { buildSide, coverage, quickTrade, type CompareEdition, type Coverage, type QuickTrade } from "./compare"
import { readCandidates, readChain, readOnChainCount, CANDIDATE_LIMIT } from "./read"
import type { SwapCollection } from "@/lib/trade-room/multi-swap-cadence"

/** A transient failure outside our DB (the chain, Dapper's username lookup): retryable. */
export class UpstreamError extends Error {}

function upstream<T>(p: Promise<T>, what: string): Promise<T> {
  return p.catch((e: unknown) => {
    throw new UpstreamError(`${what}: ${e instanceof Error ? e.message : String(e)}`)
  })
}

export const USERNAME_INPUT = /^@?[A-Za-z0-9_.-]{1,40}$/

export function isCompareIdentifier(v: string): boolean {
  return USERNAME_INPUT.test(v) || isWalletAddress(v)
}

type Who = { address: string; username: string }

/**
 * Top Shot's own capitalisation of a username. The resolver's cache can hold the spelling a
 * visitor TYPED ("jamesdillonbond" for "Jamesdillonbond"); a saved wallet carries the spelling
 * the collector's own account resolved. Same name ignoring case → that spelling; anything else
 * (no row, a read error) keeps the resolver's — display only, never a lookup key.
 */
async function displaySpelling(db: SupabaseClient, address: string, resolved: string): Promise<string> {
  const { data, error } = await db.from("saved_wallets").select("username").eq("wallet_addr", address).not("username", "is", null).limit(10)
  if (error || !Array.isArray(data)) return resolved
  const match = (data as Array<{ username: string | null }>).map((r) => r.username).find((u) => u && u !== resolved && u.toLowerCase() === resolved.toLowerCase())
  return match ?? resolved
}

async function resolve(db: SupabaseClient, raw: string): Promise<Who | "not_found" | "failed"> {
  const v = raw.trim()
  if (isWalletAddress(v)) {
    const address = v.toLowerCase()
    // show the collector's name when RPC knows it; an address otherwise (never echoed back as a wallet field)
    const { data } = await db.from("wallet_usernames").select("username").eq("wallet_addr", address).maybeSingle()
    const name = (data as { username?: string } | null)?.username
    return { address, username: name ?? `${address.slice(0, 6)}…${address.slice(-4)}` }
  }
  const r = await resolveTopShotUsernameCacheAware(db, v)
  if (r.found) {
    const address = r.walletAddress.toLowerCase()
    return { address, username: await displaySpelling(db, address, r.username) }
  }
  return r.reason === "topshot_gql_error" ? "failed" : "not_found"
}

export interface CompareSide {
  username: string
  editions: CompareEdition[]
  /** Editions with at least one tradeable copy (all of them are in `editions`). */
  editions_total: number
  /** Candidate Moments the index offered before the chain read. */
  candidates_total: number
  /** True when the index held more candidates than were read (highest FMV first). */
  capped: boolean
  blocked: { locked: number; listed: number; gone: number }
  coverage: Coverage
  /** A walk was dispatched (or already ran recently) because the index is short. */
  indexing: boolean
}

export interface CompareResult {
  collection: string
  a: CompareSide
  b: CompareSide
  quick_trade: QuickTrade | null
  candidate_limit: number
  checked_at: string
}

export type CompareOutcome = { kind: "ok"; result: CompareResult } | { kind: "not_found"; username: string } | { kind: "same_wallet" }

export interface RunDeps {
  /** Called for a wallet whose index is short of its on-chain count; returns whether a walk is (now) running. */
  onShortIndex?: (wallet: string, c: SwapCollection) => Promise<boolean>
}

export async function runCompare(db: SupabaseClient, c: SwapCollection, u1: string, u2: string, deps: RunDeps = {}): Promise<CompareOutcome> {
  const [ra, rb] = await Promise.all([resolve(db, u1), resolve(db, u2)])
  for (const [r, raw] of [[ra, u1], [rb, u2]] as const) {
    if (r === "failed") throw new UpstreamError(`username lookup failed for ${raw}`)
    if (r === "not_found") return { kind: "not_found", username: raw.replace(/^@/, "") }
  }
  const a = ra as Who
  const b = rb as Who
  if (a.address === b.address) return { kind: "same_wallet" }

  const [raw, countA, countB] = await Promise.all([
    readCandidates(db, c.collectionId, a.address, b.address),
    readOnChainCount(a.address, c),
    readOnChainCount(b.address, c),
  ])
  const [chainA, chainB] = await Promise.all([
    upstream(readChain(db, c, a.address, raw.a_rows), "chain read A"),
    upstream(readChain(db, c, b.address, raw.b_rows), "chain read B"),
  ])

  const sideA = buildSide(raw.a_rows, chainA)
  const sideB = buildSide(raw.b_rows, chainB)
  const covA = coverage(raw.a_indexed, countA)
  const covB = coverage(raw.b_indexed, countB)
  const walk = deps.onShortIndex
  const [indexingA, indexingB] = await Promise.all([
    walk && covA.complete === false ? walk(a.address, c) : Promise.resolve(false),
    walk && covB.complete === false ? walk(b.address, c) : Promise.resolve(false),
  ])

  const side = (who: Who, s: typeof sideA, total: number, rows: number, cov: Coverage, indexing: boolean): CompareSide => ({
    username: who.username,
    editions: s.editions,
    editions_total: s.editions.length,
    candidates_total: total,
    capped: total > rows,
    blocked: s.blocked,
    coverage: cov,
    indexing,
  })

  return {
    kind: "ok",
    result: {
      collection: c.slug,
      a: side(a, sideA, raw.a_total, raw.a_rows.length, covA, indexingA),
      b: side(b, sideB, raw.b_total, raw.b_rows.length, covB, indexingB),
      quick_trade: quickTrade(sideA.editions, sideB.editions, sideA.confident, sideB.confident),
      candidate_limit: CANDIDATE_LIMIT,
      checked_at: new Date().toISOString(),
    },
  }
}
