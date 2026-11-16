// app/api/public/trades/compare/route.ts
//
// /trades/compare's read (2026-11-16): two Top Shot usernames (or Flow addresses) in, the
// Moments each could trade the other out. Public, no sign-in — RPC asks for identifiers, never a
// wallet connect, to READ (rpc-no-wallet-signin).
//
//   GET ?u1=<username|0x…>&u2=<username|0x…>[&c=nba-top-shot|nfl-all-day|laliga-golazos]
//     -> { collection, a: Side, b: Side, quick_trade: QuickTrade | null, checked_at }
//   (2026-11-16 afternoon: All Day and Golazos too. One Dapper wallet holds all three, so a Top
//    Shot username names the wallet. An unknown `c` is REFUSED (400), never answered as Top Shot —
//    the substitution rule; an ABSENT `c` defaults to Top Shot.)
//
// Side = { username, editions[], editions_total, candidates_total, capped, blocked, coverage }
//
// Order of truth: RPC's index names the CANDIDATES (get_trade_compare); the CHAIN decides
// what is tradeable (held, unlocked, not listed). A failed chain read is a 503 — never a list
// of unverified Moments, never "nothing to trade". An unknown username is a 404 by name; a
// lookup that FAILED is a 503 (never "no such user").
//
// Usernames are matched case-insensitively (thetradefloor answered "No Top Shot user" for
// "jamesdillonbond" because it wanted "Jamesdillonbond"); the reply carries the canonical spelling.
// No wallet address ever leaves the server. FMV confidence tiers never leave the server.
//
// Durable anon caps (lib/abuse/anon-rate.ts, fail closed): one compare fans out to ~25 Flow REST
// calls, so per IP 30/h and globally 600/h. When a wallet's index is SHORT of its on-chain count,
// the Top Shot walk is dispatched (per wallet once per 6 h, globally 60/h) and the page says so.

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { boardUnavailable } from "@/lib/insights/board-error"
import { anonIpKey, bumpAnonRates } from "@/lib/abuse/anon-rate"
import { isWalletAddress, resolveTopShotUsernameCacheAware } from "@/lib/chains/flow/topshot-username-resolve"
import { buildSide, coverage, quickTrade, type CompareEdition, type Coverage } from "@/lib/trade-compare/compare"
import { compareCollection, readCandidates, readChain, readOnChainCount, CANDIDATE_LIMIT } from "@/lib/trade-compare/read"
import type { SwapCollection } from "@/lib/trade-room/multi-swap-cadence"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"

export const dynamic = "force-dynamic"
export const maxDuration = 60
/** The whole compare (DB + ~25 chain calls) is bounded under maxDuration so the 503 can still be sent. */
const COMPARE_BUDGET_MS = 50_000

const NAME = /^@?[A-Za-z0-9_.-]{1,40}$/

type Who = { address: string; username: string }

/** A transient failure outside our DB (the chain, Dapper's username lookup, the rate counter): a
 *  retryable 503 in our own words. apiErrorResponse() would call an unrecognised Error a permanent 500. */
class UpstreamError extends Error {}

function upstream503(message: string): NextResponse {
  return NextResponse.json(
    { error: message, code: "upstream_unavailable", retryable: true },
    { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "30" } },
  )
}

function upstream<T>(p: Promise<T>, what: string): Promise<T> {
  return p.catch((e: unknown) => {
    throw new UpstreamError(`${what}: ${e instanceof Error ? e.message : String(e)}`)
  })
}

async function resolve(raw: string): Promise<Who | "not_found" | "failed"> {
  const v = raw.trim()
  if (isWalletAddress(v)) {
    const address = v.toLowerCase()
    // show the collector's name when RPC knows it; an address otherwise (never echoed back as a wallet field)
    const { data } = await supabaseAdmin.from("wallet_usernames").select("username").eq("wallet_addr", address).maybeSingle()
    const name = (data as { username?: string } | null)?.username
    return { address, username: name ?? `${address.slice(0, 6)}…${address.slice(-4)}` }
  }
  const r = await resolveTopShotUsernameCacheAware(supabaseAdmin, v)
  if (r.found) {
    const address = r.walletAddress.toLowerCase()
    return { address, username: await displaySpelling(address, r.username) }
  }
  return r.reason === "topshot_gql_error" ? "failed" : "not_found"
}

/**
 * Top Shot's own capitalisation of a username. The resolver's cache can hold the spelling a
 * visitor TYPED ("jamesdillonbond" for "Jamesdillonbond"); a saved wallet carries the spelling
 * the collector's own account resolved. Same name ignoring case → that spelling; anything else
 * (no row, a read error) keeps the resolver's — display only, never a lookup key.
 */
async function displaySpelling(address: string, resolved: string): Promise<string> {
  const { data, error } = await supabaseAdmin.from("saved_wallets").select("username").eq("wallet_addr", address).not("username", "is", null).limit(10)
  if (error || !Array.isArray(data)) return resolved
  const match = (data as Array<{ username: string | null }>).map((r) => r.username).find((u) => u && u !== resolved && u.toLowerCase() === resolved.toLowerCase())
  return match ?? resolved
}

async function dispatchWalk(req: NextRequest, wallet: string): Promise<boolean> {
  const token = process.env.INGEST_SECRET_TOKEN
  if (!token) return false
  const verdict = await bumpAnonRates([
    { bucket: "trade_compare_walk:global", key: "*", limit: 60, windowSecs: 3600 },
    { bucket: "trade_compare_walk:wallet", key: wallet, limit: 1, windowSecs: 6 * 3600 },
  ])
  if (!verdict.allowed) return verdict.refusedBucket === "trade_compare_walk:wallet" && !verdict.failed
  const origin = new URL(req.url).origin
  after(async () => {
    try {
      await fetch(`${origin}/api/wallet-backfill`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ wallet }),
        // fire-and-forget: the walk keeps running server-side; this only lets THIS lambda exit
        signal: AbortSignal.timeout(45_000),
      })
    } catch {
      /* best-effort; the page already says the index is short */
    }
  })
  return true
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
  /** The Top Shot walk was dispatched (or already ran in the last 6 h) because the index is short. */
  indexing: boolean
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const u1 = (sp.get("u1") ?? "").trim()
  const u2 = (sp.get("u2") ?? "").trim()
  const c = compareCollection(sp.get("c") ?? "nba-top-shot")
  if (!c) return NextResponse.json({ error: "Compare covers NBA Top Shot, NFL All Day and LaLiga Golazos.", code: "bad_collection" }, { status: 400 })
  for (const u of [u1, u2]) {
    if (!u || !(NAME.test(u) || isWalletAddress(u))) {
      return NextResponse.json({ error: "Enter two Top Shot usernames.", code: "bad_input" }, { status: 400 })
    }
  }

  const ip = anonIpKey(req.headers)
  const verdict = await bumpAnonRates([
    { bucket: "trade_compare:global", key: "*", limit: 600, windowSecs: 3600 },
    ...(ip ? [{ bucket: "trade_compare:ip", key: ip, limit: 30, windowSecs: 3600 }] : []),
  ])
  if (!verdict.allowed) {
    if (verdict.failed) return upstream503("Compare isn't available right now. Try again in a moment.")
    return NextResponse.json({ error: "Too many compares from here in the last hour. Try again later.", code: "rate_limited" }, { status: 429 })
  }

  try {
    return await withBoardBudget(compare(req, c, u1, u2), "compare", COMPARE_BUDGET_MS, "trades/")
  } catch (e) {
    if (e instanceof UpstreamError) {
      console.warn(`[trades/compare] ${e.message}`)
      return upstream503("We couldn't read those collections from the Flow blockchain or Top Shot just now. This is temporary, not an empty result — try again in a moment.")
    }
    return boardUnavailable(e, "trades-compare", "We couldn't check those collections right now. Try again in a moment.")
  }
}

async function compare(req: NextRequest, c: SwapCollection, u1: string, u2: string): Promise<NextResponse> {
  {
    const [ra, rb] = await Promise.all([resolve(u1), resolve(u2)])
    for (const [r, raw] of [[ra, u1], [rb, u2]] as const) {
      if (r === "failed") throw new UpstreamError(`username lookup failed for ${raw}`)
      if (r === "not_found") {
        return NextResponse.json({ error: `No Top Shot collector named "${raw.replace(/^@/, "")}".`, code: "not_found", username: raw }, { status: 404 })
      }
    }
    const a = ra as Who
    const b = rb as Who
    if (a.address === b.address) {
      return NextResponse.json({ error: "Those are the same collector. Enter two different usernames.", code: "same_wallet" }, { status: 400 })
    }

    const [raw, countA, countB] = await Promise.all([
      readCandidates(supabaseAdmin, c.collectionId, a.address, b.address),
      readOnChainCount(a.address, c),
      readOnChainCount(b.address, c),
    ])
    const [chainA, chainB] = await Promise.all([
      upstream(readChain(supabaseAdmin, c, a.address, raw.a_rows), "chain read A"),
      upstream(readChain(supabaseAdmin, c, b.address, raw.b_rows), "chain read B"),
    ])

    const sideA = buildSide(raw.a_rows, chainA)
    const sideB = buildSide(raw.b_rows, chainB)
    const covA = coverage(raw.a_indexed, countA)
    const covB = coverage(raw.b_indexed, countB)
    // the walk dispatched here is Top Shot's (fire-and-forget); All Day's is a long SYNC walk owned
    // by the multicollection orchestrator, so a short All Day / Golazos index is said, not walked
    const walks = c.slug === "nba-top-shot"
    const [indexingA, indexingB] = await Promise.all([
      walks && covA.complete === false ? dispatchWalk(req, a.address) : Promise.resolve(false),
      walks && covB.complete === false ? dispatchWalk(req, b.address) : Promise.resolve(false),
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

    return NextResponse.json(
      {
        collection: c.slug,
        a: side(a, sideA, raw.a_total, raw.a_rows.length, covA, indexingA),
        b: side(b, sideB, raw.b_total, raw.b_rows.length, covB, indexingB),
        quick_trade: quickTrade(sideA.editions, sideB.editions, sideA.confident, sideB.confident),
        candidate_limit: CANDIDATE_LIMIT,
        checked_at: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    )
  }
}
