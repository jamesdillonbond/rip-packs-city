import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import fcl from "@/lib/chains/flow/flow"
import * as t from "@onflow/types"
import { GET_UNLOCKED_MOMENT_DETAILS } from "@/lib/chains/flow/allday-cadence"

const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"

// Recompute is_locked for an All Day wallet by diffing the on-chain unlocked NFT IDs
// against the full set of moment IDs already stored in wallet_moments_cache for this
// wallet (populated from Flowty, which includes both locked and unlocked moments).
//
// Locked moments are moved to Dapper custodial infrastructure, so they never appear
// in the on-chain Cadence result. Any cached moment not present on-chain is locked.
export async function GET(req: NextRequest) {
  const walletInput = req.nextUrl.searchParams.get("wallet")
  if (!walletInput) return NextResponse.json({ error: "wallet required" }, { status: 400 })
  const wallet = walletInput.startsWith("0x") ? walletInput : `0x${walletInput}`

  try {
    // 1. On-chain unlocked NFT IDs (Cadence)
    const raw = await fcl.query({
      cadence: GET_UNLOCKED_MOMENT_DETAILS,
      args: (arg: any) => [arg(wallet, t.Address)],
    })
    const triples: string[][] = Array.isArray(raw) ? (raw as any) : []
    const unlockedIds = new Set<string>()
    for (const row of triples) {
      if (Array.isArray(row) && row.length > 0) unlockedIds.add(String(row[0]))
    }

    // 2. Every cached moment for this wallet in the All Day collection
    const { data: cached, error: cacheErr } = await (supabaseAdmin as any)
      .from("wallet_moments_cache")
      .select("moment_id, is_locked")
      .eq("wallet_address", wallet)
      .eq("collection_id", ALLDAY_COLLECTION_ID)

    if (cacheErr) return NextResponse.json({ error: cacheErr.message }, { status: 500 })

    const rows = cached ?? []
    const toLock: string[] = []
    const toUnlock: string[] = []
    for (const r of rows) {
      const id = String(r.moment_id)
      const shouldLock = !unlockedIds.has(id)
      if (shouldLock && r.is_locked !== true) toLock.push(id)
      else if (!shouldLock && r.is_locked !== false) toUnlock.push(id)
    }

    // 3. Batch update
    //
    // lock_checked_at is stamped alongside is_locked (added 2026-07-19).
    // Previously this route wrote is_locked and NOTHING else, so All Day ended
    // up with 3,682 rows flagged locked and ZERO rows carrying a check
    // timestamp — the lock values were real (they come from the on-chain
    // unlocked-id diff above) but their freshness was unknowable. That matters
    // because Top Shot locks expire and the wmc lock display is only honest if
    // we can say how old a check is; without a timestamp All Day reads as
    // "never checked" and is indistinguishable from genuinely-missing data.
    // It also made lock-check-batch report All Day under
    // `unsupported_collections`, implying nothing maintains its locks, when in
    // fact this route does.
    const CHUNK = 200
    const checkedAt = new Date().toISOString()

    for (let i = 0; i < toLock.length; i += CHUNK) {
      const slice = toLock.slice(i, i + CHUNK)
      await (supabaseAdmin as any)
        .from("wallet_moments_cache")
        .update({ is_locked: true, lock_checked_at: checkedAt })
        .eq("wallet_address", wallet)
        .eq("collection_id", ALLDAY_COLLECTION_ID)
        .in("moment_id", slice)
    }
    for (let i = 0; i < toUnlock.length; i += CHUNK) {
      const slice = toUnlock.slice(i, i + CHUNK)
      await (supabaseAdmin as any)
        .from("wallet_moments_cache")
        .update({ is_locked: false, lock_checked_at: checkedAt })
        .eq("wallet_address", wallet)
        .eq("collection_id", ALLDAY_COLLECTION_ID)
        .in("moment_id", slice)
    }

    // Stamp the rows whose lock state did NOT change. The two loops above only
    // touch rows that flipped, so without this the steady-state (nothing
    // changed) leaves every row's timestamp stale forever and freshness never
    // advances — the failure this fix exists to remove. is_locked is
    // deliberately not written here: this asserts "verified at", not a value.
    const allExamined = rows.map((r: { moment_id: unknown }) => String(r.moment_id))
    for (let i = 0; i < allExamined.length; i += CHUNK) {
      const slice = allExamined.slice(i, i + CHUNK)
      await (supabaseAdmin as any)
        .from("wallet_moments_cache")
        .update({ lock_checked_at: checkedAt })
        .eq("wallet_address", wallet)
        .eq("collection_id", ALLDAY_COLLECTION_ID)
        .in("moment_id", slice)
    }

    return NextResponse.json({
      wallet,
      total_cached: rows.length,
      unlocked_onchain: unlockedIds.size,
      marked_locked: toLock.length,
      marked_unlocked: toUnlock.length,
    })
  } catch (err) {
    console.log("[allday-lock-refresh] error:", err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: err instanceof Error ? err.message : "internal error" }, { status: 500 })
  }
}
