import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { isWalletAddress, lookupCachedTopShotUsername } from "@/lib/chains/flow/topshot-username-resolve"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ⚠ `get_wallet_summary` takes a Flow ADDRESS. The Collection tab calls this
// route with whatever the reader typed — and the front door tells them to
// "paste a Top Shot username". Measured 2026-09-06 on the founder's own wallet
// (`jamesdillonbond`, 15,284 Moments): the RPC answered the username with
// {total_moments: 0, wallet_fmv: 0, …} under HTTP 200, and the page published
// WALLET FMV $0 · UNLOCKED $0 · 0 unlocked · LOCKED $0 · 0 locked in four tiles
// while the Moment table below them summed to $28,480. A read that resolved
// nothing rendered as a fact about the collection — the honesty canon's worst
// sub-class, a false claim about the reader's own account.
//
// Resolve a username through the same cached ladder /api/collection-moments
// uses; if nothing resolves, say so (404 with the unresolved shape) rather than
// forwarding the RPC's zeros.
export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")
  if (!wallet || !wallet.trim()) return NextResponse.json({ error: "wallet required" }, { status: 400 })

  const collectionId = req.nextUrl.searchParams.get("collection_id") || "95f28a17-224a-4025-96ad-adf8a4c63bfd"

  let address = wallet.trim()
  if (!isWalletAddress(address)) {
    let resolved: string | null = null
    try {
      resolved = await lookupCachedTopShotUsername(supabase as any, address)
    } catch (e) {
      return apiErrorResponse(e, "api/wallet-summary/resolve-username")
    }
    if (!resolved) {
      return NextResponse.json(
        { error: "unresolved", message: "That Top Shot username is not in our index yet — try the 0x wallet address." },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      )
    }
    address = resolved
  }

  const { data, error } = await boundedRead(supabase.rpc("get_wallet_summary", {
    p_wallet: address,
    p_collection_id: collectionId,
  }), "api/wallet-summary/get_wallet_summary")

  if (error) return apiErrorResponse(error, "api/wallet-summary")
  return NextResponse.json({ ...(data ?? {}), resolved_wallet: address })
}
