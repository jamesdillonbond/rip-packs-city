import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { refreshAllDayWalletLocks } from "@/lib/allday-lock"

// Recompute is_locked (+ lock_checked_at) for one All Day wallet by diffing the
// on-chain unlocked NFT ids against wallet_moments_cache. Locked All Day moments
// are moved to Dapper custodial infrastructure, so they never appear on-chain;
// any cached moment not present on-chain is locked.
//
// The diff walk is whale-safe (chunked GET_UNLOCKED_MOMENT_DETAILS_RANGE) and
// lives in lib/allday-lock.ts, shared with the scheduled batch orchestrator
// /api/cron/allday-lock-refresh-batch. See that route for scheduling; this
// endpoint stays available for a single on-demand wallet refresh.

export const maxDuration = 60

export async function GET(req: NextRequest) {
  const walletInput = req.nextUrl.searchParams.get("wallet")
  if (!walletInput) return NextResponse.json({ error: "wallet required" }, { status: 400 })
  const wallet = walletInput.startsWith("0x") ? walletInput : `0x${walletInput}`

  try {
    const result = await refreshAllDayWalletLocks(wallet, supabaseAdmin)
    return NextResponse.json(result)
  } catch (err) {
    console.log("[allday-lock-refresh] error:", err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: err instanceof Error ? err.message : "internal error" }, { status: 500 })
  }
}
