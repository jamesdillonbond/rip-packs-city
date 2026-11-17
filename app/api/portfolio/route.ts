// app/api/portfolio/route.ts
// GET /api/portfolio?wallet=0x... — cross-collection portfolio breakdown.
//
// ⓘ NO OWNERSHIP CHECK, ON PURPOSE (security audit 2026-10-25, finding 9 —
// re-derived and closed). This returns per-collection holdings counts and FMV
// totals for a wallet: on-chain holdings priced by public FMV, the same data
// the anonymous /share/[wallet] page and the public `/<collection>/collection`
// tab already show for any address (proxy.ts "Public feature-tab surfaces").
// Cost basis and P&L — the genuinely private figures — live in /api/cost-basis
// and /api/wallet-cost-basis, which DO call requireOwnedKey. Adding the guard
// here would also 403 every Candy (base58) wallet, which requireOwnedKey cannot
// resolve. If this route ever starts returning acquisition cost, gate it.

import { NextRequest, NextResponse } from "next/server"
import { normalizeAddress } from "@/lib/address"
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  // ⛔ 2026-09-19 — was `.trim().toLowerCase()`. This is the CROSS-COLLECTION
  // portfolio, so a Candy wallet is exactly what belongs here, and base58 is
  // CASE-SENSITIVE: folding it produced a structurally complete answer of
  // ZEROS. Measured live on a real Candy wallet: correct key →
  // total_fmv 19,386.54; lowercased → total_fmv 0.00, collections [],
  // total_moments 0 — and the RPC ECHOES the mangled wallet back, so the
  // response looks like a true reading of that wallet. `normalizeAddress` folds
  // hex exactly as before, so no Flow caller moves.
  const wallet = normalizeAddress(req.nextUrl.searchParams.get("wallet")?.trim() ?? "")
  if (!wallet) {
    return NextResponse.json({ error: "wallet required" }, { status: 400 })
  }

  try {
    const { data, error } = await boundedRead((supabaseAdmin as any).rpc(
      "get_cross_collection_portfolio",
      { p_wallet: wallet }
    ), "api/portfolio/get_cross_collection_portfolio")
    if (error) {
      return apiErrorResponse(error, "api/portfolio");
    }
    return NextResponse.json(data ?? {}, {
      headers: { "Cache-Control": "public, max-age=0, s-maxage=120" },
    })
  } catch (err) {
    return apiErrorResponse(err, "api/portfolio");
  }
}
