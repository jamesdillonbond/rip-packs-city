// app/api/wallet/sold-pack-outcomes/route.ts
//
// GET /api/wallet/sold-pack-outcomes?wallet=&ids=<pack_nft_id>,<pack_nft_id>,…
//
// 2026-11-27 (Trevor: "I'd like to see if any of the packs I sold had something good").
// For packs this wallet SOLD sealed: who opened them (by username), when, and every pull at
// current FMV. Wraps get_wallet_sold_pack_outcomes (migration audit_20261127_sold_pack_outcomes),
// which only answers ids the wallet appears as the SELLER of and never returns an opener address.
//
// Auth: same gate as /api/wallet/pack-history -- a signed-in user, and the wallet SAVED on that
// account (known-issues #59: saved, not verified).
//
// Honesty: a failed read is a 503 via apiErrorResponse, never an empty list -- the binder renders
// "couldn't load" for a failure and "not opened yet" only for a pack the read says is sealed.

import { normalizeAddress } from "@/lib/address"
import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { supabaseAdmin } from "@/lib/supabase"
import { requireUser } from "@/lib/auth/supabase-server"
import { parseSoldPackIds, SOLD_PACK_OUTCOMES_MAX_IDS } from "@/lib/packs-sold-outcomes"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = supabaseAdmin

/** Measured 2026-11-27: 100 ids on the busiest seller in 0.6 s. Under the RPC's own 15 s timeout. */
export const SOLD_PACK_OUTCOMES_READ_BUDGET_MS = 12_000
export const maxDuration = 30

export async function GET(req: NextRequest) {
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }

  const url = req.nextUrl
  const wallet = normalizeAddress(url.searchParams.get("wallet") ?? "")
  if (!wallet) {
    return NextResponse.json({ error: "wallet required" }, { status: 400 })
  }
  const ids = parseSoldPackIds(url.searchParams.get("ids"))
  if (ids === null) {
    return NextResponse.json({ error: `ids must be up to ${SOLD_PACK_OUTCOMES_MAX_IDS} numeric pack ids` }, { status: 400 })
  }
  if (ids.length === 0) {
    return NextResponse.json({ packs: [] }, { headers: { "Cache-Control": "no-cache, no-store, must-revalidate" } })
  }

  const { data: matches, error: lookupErr } = await boundedRead(sb
    .from("saved_wallets")
    .select("wallet_addr")
    .eq("user_id", user.id)
    .eq("wallet_addr", wallet)
    .limit(1), "api/wallet/sold-pack-outcomes/saved_wallets")
  if (lookupErr) {
    console.error("[wallet/sold-pack-outcomes] verify lookup", lookupErr.message)
    return apiErrorResponse(lookupErr, "api/wallet/sold-pack-outcomes")
  }
  if (!matches || matches.length === 0) {
    return NextResponse.json({ error: "wallet not saved on this account" }, { status: 403 })
  }

  try {
    const { data, error } = await boundedRead(sb.rpc("get_wallet_sold_pack_outcomes", {
      p_wallet: wallet,
      p_pack_nft_ids: ids,
    }), "api/wallet/sold-pack-outcomes/get_wallet_sold_pack_outcomes", SOLD_PACK_OUTCOMES_READ_BUDGET_MS)
    if (error) {
      console.error("[wallet/sold-pack-outcomes]", error.message)
      return apiErrorResponse(error, "api/wallet/sold-pack-outcomes")
    }
    if (!Array.isArray(data)) {
      return apiErrorResponse(new Error("get_wallet_sold_pack_outcomes returned a non-array"), "api/wallet/sold-pack-outcomes")
    }
    return NextResponse.json({ packs: data }, {
      headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
    })
  } catch (err) {
    console.error("[wallet/sold-pack-outcomes] unexpected", err instanceof Error ? err.message : String(err))
    return apiErrorResponse(err, "api/wallet/sold-pack-outcomes")
  }
}
