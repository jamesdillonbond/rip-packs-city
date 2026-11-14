// app/api/wallet-offers/route.ts
//
// GET /api/wallet-offers?wallet=0x...|username&collection=<slug>&limit=25
// The offers a wallet has MADE (it is the offerer), newest first, plus status
// totals. Source: the on-chain `offers` table written by topshot-offers-indexer
// (Dapper OffersV2, from 2026-06-03).
//
// ⚠ COVERAGE IS TOP SHOT ONLY. No other collection has a per-wallet offers
// table, so for any other collection this answers `supported: false` with no
// rows — never an empty list, which the card would have to render as "this
// wallet has made no offers", a claim nobody measured.
//
// Read-only: RPC shows offers, it never makes or accepts one.
//
// `view=open` (feedback #12361, "my open offers"): the wallet's OPEN offers from
// get_topshot_wallet_open_offers — each against the best OTHER-wallet bid, the
// wallet's own higher bid (superseded, not outbid) and the edition floor — plus
// a summary. The default response (no `view`) is unchanged.
//   - the flag counts are over the rows RETURNED (newest first, capped at
//     OPEN_CAP); `summary.open` is a separately MEASURED total, and
//     `truncated` says when the two differ, so a capped list never passes for
//     the whole set;
//   - a failed RPC or count is an error response, never `rows: []`.

import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse, isUnresolvedIdentifierError, unresolvedIdentifierResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { supabaseAdmin } from "@/lib/supabase"
import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections"
import { isOnChainAddress } from "@/lib/postgrest-safe"
import { normalizeAddress } from "@/lib/address"
import { resolveToFlowAddress, UsernameLookupUnavailableError, usernameLookupUnavailableResponse } from "@/lib/chains/flow/flow-resolve"
import { ownLookup } from "@/lib/safe-lookup"
import { classifyOpenOffer } from "@/lib/market/open-offer-flags"

const TOPSHOT_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const OFFER_TRACKED_COLLECTIONS = new Set([TOPSHOT_UUID])
const TRACKED_SINCE = "2026-06-03"
const STATUSES = ["open", "filled", "cancelled"] as const
/** Rows the open view returns (newest first). The RPC's own hard cap is 500. */
const OPEN_CAP = 500

async function resolveWallet(input: string): Promise<string> {
  const t = input.trim()
  if (isOnChainAddress(t)) return normalizeAddress(t)
  return resolveToFlowAddress(t)
}

export type WalletOfferRow = {
  offer_type: string | null
  amount_usd: number | null
  status: string | null
  created_at: string | null
  resolved_at: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  serial_number: number | null
  edition_external_id: string | null
}

export type WalletOpenOfferRow = {
  offer_id: string
  offer_type: string | null
  amount_usd: number | null
  created_at: string | null
  edition_id: string | null
  edition_external_id: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  parallel: string | null
  serial_number: number | null
  /** Highest open offer by ANOTHER wallet on the same target; null = none. */
  top_other_bid: number | null
  /** This wallet's own strictly-higher open offer on the same target; null = none. */
  own_higher_usd: number | null
  /** edition low ask; null = unknown, never 0. */
  floor_usd: number | null
  floor_confirmed_at: string | null
  /** Serial offers only: a listing of that Moment SEEN recently; null = not seen (never "not listed"). */
  serial_ask_usd: number | null
  serial_ask_seen_at: string | null
  age_days: number | null
  outbid: boolean
  superseded: boolean
  stale: boolean
  at_or_above_floor: boolean
}

const num = (v: unknown): number | null => {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

async function openView(collectionSlug: string, collectionUuid: string, wallet: string) {
  const [rpcRes, countRes] = await Promise.all([
    boundedRead(
      (supabaseAdmin as any).rpc("get_topshot_wallet_open_offers", { p_wallet: wallet, p_limit: OPEN_CAP }),
      "api/wallet-offers/open",
    ),
    boundedRead(
      (supabaseAdmin as any)
        .from("offers")
        .select("offer_id", { count: "exact", head: true })
        .eq("collection_id", collectionUuid)
        .eq("buyer_address", wallet)
        .eq("status", "open"),
      "api/wallet-offers/count-open",
    ),
  ])
  if (rpcRes.error) throw new Error(rpcRes.error.message)
  if (!Array.isArray(rpcRes.data)) throw new Error("get_topshot_wallet_open_offers returned no rows array")
  if (countRes.error) throw new Error(countRes.error.message)
  if (typeof countRes.count !== "number") throw new Error("offers count(open) returned no count")

  const now = Date.now()
  const rows: WalletOpenOfferRow[] = (rpcRes.data as any[]).map((r) => {
    const base = {
      offer_id: String(r.offer_id),
      offer_type: r.offer_type ?? null,
      amount_usd: num(r.amount_usd),
      created_at: r.created_at ?? null,
      edition_id: r.edition_id ?? null,
      edition_external_id: r.external_id ?? null,
      player_name: r.player_name ?? null,
      set_name: r.set_name ?? null,
      tier: r.tier ?? null,
      parallel: r.parallel ?? null,
      serial_number: r.serial_number ?? null,
      top_other_bid: num(r.top_other_bid),
      own_higher_usd: num(r.own_higher_usd),
      floor_usd: num(r.floor_usd),
      floor_confirmed_at: r.floor_confirmed_at ?? null,
      serial_ask_usd: num(r.serial_ask_usd),
      serial_ask_seen_at: r.serial_ask_seen_at ?? null,
      age_days: num(r.age_days),
    }
    return { ...base, ...classifyOpenOffer(base, now) }
  })

  return NextResponse.json(
    {
      wallet,
      collection: collectionSlug,
      supported: true,
      view: "open",
      tracked_since: TRACKED_SINCE,
      summary: {
        open: countRes.count,
        shown: rows.length,
        truncated: rows.length < countRes.count,
        outbid: rows.filter((r) => r.outbid).length,
        superseded: rows.filter((r) => r.superseded).length,
        stale: rows.filter((r) => r.stale).length,
        at_or_above_floor: rows.filter((r) => r.at_or_above_floor).length,
      },
      rows,
    },
    { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } },
  )
}

export async function GET(req: NextRequest) {
  try {
    const walletInput = req.nextUrl.searchParams.get("wallet")
    if (!walletInput) return NextResponse.json({ error: "wallet required" }, { status: 400 })

    const collectionSlug = req.nextUrl.searchParams.get("collection")?.trim() || ""
    const collectionUuid = ownLookup(COLLECTION_UUID_BY_SLUG, collectionSlug)
    if (!collectionUuid) {
      return NextResponse.json({ error: `unknown collection: ${collectionSlug}` }, { status: 400 })
    }

    const view = req.nextUrl.searchParams.get("view")
    if (view != null && view !== "open") {
      return NextResponse.json({ error: `unknown view: ${view}` }, { status: 400 })
    }

    if (!OFFER_TRACKED_COLLECTIONS.has(collectionUuid)) {
      return NextResponse.json(
        { collection: collectionSlug, supported: false, rows: [], summary: null },
        { headers: { "Cache-Control": "public, max-age=300" } },
      )
    }

    if (view === "open") return await openView(collectionSlug, collectionUuid, await resolveWallet(walletInput))

    const limitRaw = Number(req.nextUrl.searchParams.get("limit") ?? 25)
    const limit = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? limitRaw : 25))

    const wallet = await resolveWallet(walletInput)

    const [listRes, ...countRes] = await Promise.all([
      boundedRead(
        (supabaseAdmin as any)
          .from("offers")
          .select("offer_type, offer_amount_usd, status, created_at, resolved_at, serial_number, editions:edition_id(player_name, set_name, tier, external_id)")
          .eq("collection_id", collectionUuid)
          .eq("buyer_address", wallet)
          .order("created_at", { ascending: false })
          .order("offer_id", { ascending: false })
          .limit(limit),
        "api/wallet-offers/offers",
      ),
      ...STATUSES.map((s) =>
        boundedRead(
          (supabaseAdmin as any)
            .from("offers")
            .select("offer_id", { count: "exact", head: true })
            .eq("collection_id", collectionUuid)
            .eq("buyer_address", wallet)
            .eq("status", s),
          `api/wallet-offers/count-${s}`,
        ),
      ),
    ])
    if (listRes.error) throw new Error(listRes.error.message)
    // Every count must be a MEASURED number — a failed head count is not zero.
    const counts: Record<string, number> = {}
    STATUSES.forEach((s, i) => {
      const r = countRes[i] as { error: { message: string } | null; count?: number | null }
      if (r.error) throw new Error(r.error.message)
      if (typeof r.count !== "number") throw new Error(`offers count(${s}) returned no count`)
      counts[s] = r.count
    })

    const rows: WalletOfferRow[] = ((listRes.data as any[]) ?? []).map((r) => {
      const e = Array.isArray(r.editions) ? r.editions[0] : r.editions
      return {
        offer_type: r.offer_type ?? null,
        amount_usd: r.offer_amount_usd != null ? Number(r.offer_amount_usd) : null,
        status: r.status ?? null,
        created_at: r.created_at ?? null,
        resolved_at: r.resolved_at ?? null,
        player_name: e?.player_name ?? null,
        set_name: e?.set_name ?? null,
        tier: e?.tier ?? null,
        serial_number: r.serial_number ?? null,
        edition_external_id: e?.external_id ?? null,
      }
    })

    return NextResponse.json(
      {
        wallet,
        collection: collectionSlug,
        supported: true,
        tracked_since: TRACKED_SINCE,
        summary: {
          total: counts.open + counts.filled + counts.cancelled,
          open: counts.open,
          filled: counts.filled,
          cancelled: counts.cancelled,
        },
        rows,
      },
      { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } },
    )
  } catch (err) {
    console.log("[wallet-offers] error:", err instanceof Error ? err.message : String(err))
    if (err instanceof UsernameLookupUnavailableError) return usernameLookupUnavailableResponse()
    if (isUnresolvedIdentifierError(err)) return unresolvedIdentifierResponse()
    return apiErrorResponse(err, "api/wallet-offers")
  }
}
