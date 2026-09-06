// app/api/wallet/pack-history/route.ts
//
// GET /api/wallet/pack-history?wallet=&collection=&status=&limit=&offset=
//
// Auth: requires a Supabase user session; verifies the requested wallet
// is SAVED on the user's account (saved_wallets; verification no longer gates — 09-06, #59).
//
// Wraps get_wallet_pack_history(p_wallet, p_collection_slug, p_status,
// p_limit, p_offset). `status` accepts all | ripped | flipped | sold | held |
// other; "all" or empty maps to NULL on the RPC. `collection` accepts the
// underscore-form DB slug (nba_top_shot, …) or the hyphen-form URL slug
// (nba-top-shot, …); both are normalized via SLUG_TO_DB_SLUG.

import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";
import { supabaseAdmin } from "@/lib/supabase"
import { requireUser } from "@/lib/auth/supabase-server"
import { SLUG_TO_DB_SLUG } from "@/lib/collections"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = supabaseAdmin

// `sold_any` is a VIRTUAL status handled inside get_wallet_pack_history —
// it means status IN ('flipped','sold'), i.e. every "sold on while sealed"
// outcome regardless of whether a matching buy row was attributable to the
// wallet. The Packs "Sold" sub-tab uses it so it can't silently hide flipped
// rows if Dapper's seller attribution improves. 'sold' keeps its exact
// meaning for existing callers (app/dashboard/packs).
const VALID_STATUSES = new Set(["ripped", "flipped", "sold", "sold_any", "held", "other"])

export async function GET(req: NextRequest) {
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }

  const url = req.nextUrl
  const wallet = (url.searchParams.get("wallet") ?? "").toLowerCase().trim()
  const collectionRaw = (url.searchParams.get("collection") ?? "").trim()
  const statusRaw = (url.searchParams.get("status") ?? "").trim().toLowerCase()
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "50", 10)
  const offsetRaw = parseInt(url.searchParams.get("offset") ?? "0", 10)

  if (!wallet) {
    return NextResponse.json({ error: "wallet required" }, { status: 400 })
  }

  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0

  // Normalize collection slug: accept hyphen-form, pass DB-form to RPC.
  let collectionSlug: string | null = null
  if (collectionRaw) {
    if (SLUG_TO_DB_SLUG[collectionRaw]) {
      collectionSlug = SLUG_TO_DB_SLUG[collectionRaw]
    } else if (Object.values(SLUG_TO_DB_SLUG).includes(collectionRaw)) {
      collectionSlug = collectionRaw
    } else {
      return NextResponse.json({ error: "unknown collection: " + collectionRaw }, { status: 400 })
    }
  }

  // status=all → NULL, otherwise must be in the allowlist.
  let status: string | null = null
  if (statusRaw && statusRaw !== "all") {
    if (!VALID_STATUSES.has(statusRaw)) {
      return NextResponse.json({ error: "invalid status: " + statusRaw }, { status: 400 })
    }
    status = statusRaw
  }

  // Wallet ownership check (same shape as /api/wallet/pack-summary).
  // 2026-09-06 (Trevor delegated the decision): the gate is "SAVED on this
  // account", no longer "VERIFIED". Verification-by-listing has had no live data
  // source since ~08-28 (public-api.nbatopshot.com is gone), so 0 wallets could
  // verify and this route was unreachable for every new user — while everything
  // it returns is public on-chain data. Ownership of the READ still requires the
  // wallet to be on the caller's account. known-issues #59.
  const { data: matches, error: lookupErr } = await boundedRead(sb
    .from("saved_wallets")
    .select("wallet_addr")
    .eq("user_id", user.id)
    .eq("wallet_addr", wallet)
    .limit(1), "api/wallet/pack-history/saved_wallets")

  if (lookupErr) {
    console.error("[wallet/pack-history] verify lookup", lookupErr.message)
    return apiErrorResponse(lookupErr, "api/wallet/pack-history");
  }
  if (!matches || matches.length === 0) {
    return NextResponse.json(
      { error: "wallet not saved on this account" },
      { status: 403 },
    )
  }

  try {
    const { data, error } = await boundedRead(sb.rpc("get_wallet_pack_history", {
      p_wallet: wallet,
      p_collection_slug: collectionSlug,
      p_status: status,
      p_limit: limit,
      p_offset: offset,
    }), "api/wallet/pack-history/get_wallet_pack_history")
    if (error) {
      console.error("[wallet/pack-history]", error.message)
      return apiErrorResponse(error, "api/wallet/pack-history");
    }
    return NextResponse.json(data ?? {}, {
      headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[wallet/pack-history] unexpected", msg)
    return apiErrorResponse(err, "api/wallet/pack-history");
  }
}
