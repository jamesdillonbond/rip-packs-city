import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

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
    const { data, error } = await supabase.rpc("get_wallet_intel_summary", {
      p_wallet: wallet,
    })

    if (error) {
      console.log("[wallet-intel] rpc error:", error.message)
      return NextResponse.json({ error: "Failed to fetch wallet intel" }, { status: 500 })
    }

    const intel = data && typeof data === "object" ? data : {}

    return NextResponse.json(intel, {
      headers: {
        // wmc + fmv refresh slowly and squeeze metrics are hourly, so a 5-minute
        // edge cache matches the data's freshness.
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
      },
    })
  } catch (err: any) {
    console.error("[wallet-intel] error:", err?.message ?? err)
    return NextResponse.json({ error: err?.message ?? "Internal server error" }, { status: 500 })
  }
}
