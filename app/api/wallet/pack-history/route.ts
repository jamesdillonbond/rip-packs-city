// app/api/wallet/pack-history/route.ts
//
// GET /api/wallet/pack-history?wallet=&collection=&status=&limit=&offset=
//
// Auth: requires a Supabase user session; verifies the requested wallet
// belongs to the user via saved_wallets.verified_at IS NOT NULL.
//
// Wraps get_wallet_pack_history(p_wallet, p_collection_slug, p_status,
// p_limit, p_offset). `status` accepts all | ripped | flipped | sold | held |
// other; "all" or empty maps to NULL on the RPC. `collection` accepts the
// underscore-form DB slug (nba_top_shot, …) or the hyphen-form URL slug
// (nba-top-shot, …); both are normalized via SLUG_TO_DB_SLUG.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { requireUser } from "@/lib/auth/supabase-server"
import { SLUG_TO_DB_SLUG } from "@/lib/collections"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = supabaseAdmin

const VALID_STATUSES = new Set(["ripped", "flipped", "sold", "held", "other"])

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
  const { data: matches, error: lookupErr } = await sb
    .from("saved_wallets")
    .select("wallet_addr")
    .eq("user_id", user.id)
    .eq("wallet_addr", wallet)
    .not("verified_at", "is", null)
    .limit(1)

  if (lookupErr) {
    console.error("[wallet/pack-history] verify lookup", lookupErr.message)
    return NextResponse.json({ error: lookupErr.message }, { status: 500 })
  }
  if (!matches || matches.length === 0) {
    return NextResponse.json(
      { error: "wallet not verified on this account" },
      { status: 403 },
    )
  }

  try {
    const { data, error } = await sb.rpc("get_wallet_pack_history", {
      p_wallet: wallet,
      p_collection_slug: collectionSlug,
      p_status: status,
      p_limit: limit,
      p_offset: offset,
    })
    if (error) {
      console.error("[wallet/pack-history]", error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json(data ?? {}, {
      headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[wallet/pack-history] unexpected", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
