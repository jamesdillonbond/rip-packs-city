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

import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse, isUnresolvedIdentifierError, unresolvedIdentifierResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { supabaseAdmin } from "@/lib/supabase"
import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections"
import { isOnChainAddress } from "@/lib/postgrest-safe"
import { normalizeAddress } from "@/lib/address"
import { resolveToFlowAddress, UsernameLookupUnavailableError, usernameLookupUnavailableResponse } from "@/lib/chains/flow/flow-resolve"
import { ownLookup } from "@/lib/safe-lookup"

const TOPSHOT_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const OFFER_TRACKED_COLLECTIONS = new Set([TOPSHOT_UUID])
const TRACKED_SINCE = "2026-06-03"
const STATUSES = ["open", "filled", "cancelled"] as const

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

export async function GET(req: NextRequest) {
  try {
    const walletInput = req.nextUrl.searchParams.get("wallet")
    if (!walletInput) return NextResponse.json({ error: "wallet required" }, { status: 400 })

    const collectionSlug = req.nextUrl.searchParams.get("collection")?.trim() || ""
    const collectionUuid = ownLookup(COLLECTION_UUID_BY_SLUG, collectionSlug)
    if (!collectionUuid) {
      return NextResponse.json({ error: `unknown collection: ${collectionSlug}` }, { status: 400 })
    }

    if (!OFFER_TRACKED_COLLECTIONS.has(collectionUuid)) {
      return NextResponse.json(
        { collection: collectionSlug, supported: false, rows: [], summary: null },
        { headers: { "Cache-Control": "public, max-age=300" } },
      )
    }

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
