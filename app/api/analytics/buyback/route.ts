// GET /api/analytics/buyback?period=week|month|year|all&limit=1..50
//
// Analytics for the NBA Top Shot secondary-BUYBACK wallets — the accounts Top
// Shot uses to repurchase moments off the secondary market and re-stuff them
// into future packs. Every buy is a curatorial signal about which players and
// sets are being elevated to "stuffable" status, which is the product value
// here.
//
// Thin wrapper over rpc_topshot_buyback_analytics (service_role-only, reads the
// daily topshot_buyback_daily MV rather than the 205k-row base table).
//
// WHAT THIS SURFACE MAY AND MAY NOT CLAIM
// ---------------------------------------
// The two questions "what are they buying" and "how much are they spending" have
// very different answers in our data, and conflating them is the failure this
// route is written to prevent:
//
//   * VOLUME is fully known. 161,366 acquisitions by the main buyback wallet
//     (0x4d2c9216f1dca098) all resolve to an edition, so "what they bought most,
//     this week / month / year / all-time" is answerable and accurate.
//
//   * SPEND is NOT known for that wallet. Its acquisitions are detected by a
//     daily holdings-snapshot diff, which carries NULL price and NULL seller on
//     100% of rows. Only the second buyback wallet (0xe1f2a091f7bb5245) trades
//     through the marketplace where our sales trigger prices it — 431 rows,
//     $10,081.93 — so priced acquisitions are 0.3% of the total.
//
// Summing spend_usd across everything and putting it next to the acquisition
// count would publish the buyback programme at roughly $0.05 a moment. So the
// payload keeps `priced_acquisitions` beside `spend_usd` at every level, carries
// an explicit `spend_known` boolean per wallet, and exposes a `coverage` block
// the client is expected to render. `$0` and `unknown` are different answers and
// this route never collapses them.
//
// Likewise `observation_start`: our snapshot history begins 2026-06-09, but the
// wallet already held 52,118 moments on 2026-05-06. "All-time" here means "since
// we started watching" and the UI must say so.
//
// A failed read returns a real error status — never a 200 with empty arrays,
// which would be byte-identical to "the buyback wallets bought nothing".

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import { apiErrorResponse } from "@/lib/api-error"

export const dynamic = "force-dynamic"
export const revalidate = 900

/**
 * The periods the RPC understands. An unknown value is REJECTED rather than
 * defaulted: silently substituting a window renders the wrong date range under
 * the label the caller asked for, which is a wrong answer wearing a right
 * answer's clothes. The RPC raises 22023 for the same reason.
 */
export const BUYBACK_PERIODS = ["week", "month", "year", "all"] as const
export type BuybackPeriod = (typeof BUYBACK_PERIODS)[number]

function parseLimit(raw: string | null): number {
  const n = parseInt(raw ?? "10", 10)
  if (!Number.isFinite(n) || n <= 0) return 10
  return Math.min(50, n)
}

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  try {
    const url = new URL(req.url)
    const periodRaw = (url.searchParams.get("period") ?? "month").toLowerCase()

    if (!(BUYBACK_PERIODS as readonly string[]).includes(periodRaw)) {
      return NextResponse.json(
        {
          error: `Unknown period. Use one of: ${BUYBACK_PERIODS.join(", ")}.`,
          code: "bad_request",
          retryable: false,
        },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      )
    }

    const period = periodRaw as BuybackPeriod
    const limit = parseLimit(url.searchParams.get("limit"))

    const { data, error } = await rpcWithRetry<Record<string, unknown>>(
      supabaseAdmin,
      "rpc_topshot_buyback_analytics",
      { p_period: period, p_limit: limit }
    )

    if (error) {
      return apiErrorResponse(
        error,
        "api/analytics/buyback",
        "Buyback analytics are unavailable right now."
      )
    }

    // A null payload is a failed read, not an empty result — the RPC always
    // builds an object, with empty arrays when a window genuinely has no
    // activity. Publishing null as "nothing bought" is the conflation this
    // route exists to avoid.
    if (data == null) {
      return apiErrorResponse(
        new Error("rpc_topshot_buyback_analytics returned no payload"),
        "api/analytics/buyback",
        "Buyback analytics are unavailable right now."
      )
    }

    console.log(
      `[analytics/buyback] ok elapsed=${Date.now() - t0}ms period=${period} limit=${limit}`
    )

    return NextResponse.json(data, {
      headers: {
        // The underlying MV refreshes once daily, so a long edge cache costs
        // nothing in freshness and keeps this 2.1s aggregate off the
        // IO-throttled instance under load.
        "Cache-Control": "public, max-age=0, s-maxage=900, stale-while-revalidate=3600",
      },
    })
  } catch (e: unknown) {
    return apiErrorResponse(
      e,
      "api/analytics/buyback",
      "Buyback analytics are unavailable right now."
    )
  }
}
