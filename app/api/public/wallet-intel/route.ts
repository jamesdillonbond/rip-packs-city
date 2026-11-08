import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { boundedRead } from "@/lib/api/bounded-read"
import { readCappedByExternalId } from "@/lib/fmv-capped"
import { walletIndexState } from "@/lib/wallet-indexed"
import { normalizeFlowAddress } from "@/lib/address"
import { apiErrorResponse } from "@/lib/api-error"

const TOP_SHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

// Backs the wallet-intel overlay on the public /share/<wallet> card. Delegates
// to get_wallet_intel_summary, a SECURITY DEFINER RPC granted to service_role
// ONLY (anon/authenticated cannot call it), so it must be reached through this
// service-role server route — same pattern as /api/collection-snapshot.
//
// The RPC is Top Shot–scoped (collection 95f28a17) and returns the wallet's TS
// intelligence lens: rookie / squeezed / trophy counts plus up to 6 ranked
// highlights. It lowercases the wallet internally, so the raw param is passed
// through. Output jsonb is returned as-is.
const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Flow addresses are 0x + 16 hex chars. Reject anything else before touching
// the DB so a malformed param can never reach the RPC.
const FLOW_ADDR = /^0x[0-9a-fA-F]{16}$/

export async function GET(req: NextRequest) {
  const walletRaw = req.nextUrl.searchParams.get("wallet")
  const wallet = (walletRaw ?? "").trim()
  if (!FLOW_ADDR.test(wallet)) {
    return NextResponse.json(
      { error: "wallet query param must be a 0x-prefixed 16-hex Flow address" },
      { status: 400 }
    )
  }

  try {
    const { data, error } = await boundedRead(
      supabase.rpc("get_wallet_intel_summary", { p_wallet: wallet }),
      "api/public/wallet-intel/get_wallet_intel_summary",
    )

    if (error) {
      console.log("[wallet-intel] rpc error:", error.message)
      return NextResponse.json({ error: "Failed to fetch wallet intel" }, { status: 500 })
    }

    const intel = data && typeof data === "object" ? data : {}

    // ⚠ #237 (2026-11-08): the RPC counts wallet_moments_cache, so a wallet RPC
    // has NEVER walked answers a complete object of zeros — byte-identical to
    // one that holds nothing. When the count is 0 (or absent), ask whether the
    // wallet was ever indexed: never → `indexed:false` with NULL figures (a
    // null is "we don't know", a 0 is a claim); a failed check is a 503.
    const moments = typeof intel.ts_moments === "number" ? intel.ts_moments : null
    if (moments === null || moments === 0) {
      const idx = await walletIndexState(supabase, wallet)
      if (!idx.ok) {
        console.log("[wallet-intel] index-state read failed")
        return apiErrorResponse(idx.error, "api/public/wallet-intel")
      }
      if (!idx.indexed) {
        return NextResponse.json(
          {
            wallet: normalizeFlowAddress(wallet) ?? wallet,
            indexed: false,
            ts_moments: null,
            ts_fmv: null,
            rookie_count: null,
            trophy_count: null,
            squeezed_count: null,
            highlights: [],
          },
          // short: a first walk can land within minutes of a share
          { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" } },
        )
      }
    }
    intel.indexed = true
    // #215: mark highlights whose ASK_ONLY price is capped at sales, for the share
    // card's "capped at sales" marker. Unchecked (no field) on any failure.
    if (Array.isArray(intel.highlights) && intel.highlights.length > 0) {
      const capped = await readCappedByExternalId(
        TOP_SHOT_COLLECTION_ID,
        intel.highlights.map((h: any) => ({ key: h?.external_id, fmv: h?.fmv_usd, confidence: h?.confidence })),
        supabase,
      )
      intel.highlights = intel.highlights.map((h: any) => ({ ...h, fmv_capped: capped.get(String(h?.external_id)) ?? null }))
    }

    return NextResponse.json(intel, {
      headers: {
        // wmc + fmv refresh slowly and squeeze metrics are hourly, so a 5-minute
        // edge cache matches the data's freshness.
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
      },
    })
  } catch (err: any) {
    console.error("[wallet-intel] error:", err?.message ?? err)
    // ⚠ ANON-FACING, and this file already had the right answer 14 lines up:
    // the rpc-error path returns the fixed copy "Failed to fetch wallet intel".
    // This catch leaked `err.message` instead — the /api/sets shape, to anonymous
    // visitors. Matched to the existing copy so the status is unchanged.
    return NextResponse.json({ error: "Failed to fetch wallet intel" }, { status: 500 })
  }
}
