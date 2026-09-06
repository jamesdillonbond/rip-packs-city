// app/api/wallet/transaction-history/route.ts
//
// GET /api/wallet/transaction-history?wallet=&kind=&limit=&offset=
//
// Unified per-wallet transaction timeline (moments + packs) — pack buys, pack
// opens, moment buys, moment pulls, moment sells in one reverse-chronological
// feed. Wraps the wallet-agnostic SECDEF RPC get_wallet_transaction_history.
//
// Auth: requires a Supabase user session AND that the requested wallet is one
// of the user's saved wallets (verification no longer gates — 09-06, #59) —
// the same ownership gate as /api/wallet/pack-history. This is the dashboard
// (own-wallet) surface; the future any-wallet analytics view should call the
// RPC behind its own appropriately-gated route, not this one.
//
// `kind` accepts all | packs | buys | sells | pulls ("all"/empty → NULL on the
// RPC). Note: "all" emits pack opens (summarized) but NOT individual pulls; the
// "pulls" filter surfaces the per-moment pulls (avoids double-counting opens).

import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";
import { supabaseAdmin } from "@/lib/supabase"
import { requireUser } from "@/lib/auth/supabase-server"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = supabaseAdmin

const VALID_KINDS = new Set(["packs", "buys", "sells", "pulls"])

export async function GET(req: NextRequest) {
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }

  const url = req.nextUrl
  const wallet = (url.searchParams.get("wallet") ?? "").toLowerCase().trim()
  const kindRaw = (url.searchParams.get("kind") ?? "").trim().toLowerCase()
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "50", 10)
  const offsetRaw = parseInt(url.searchParams.get("offset") ?? "0", 10)

  if (!wallet) {
    return NextResponse.json({ error: "wallet required" }, { status: 400 })
  }

  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0

  // kind=all/empty → NULL, otherwise must be in the allowlist.
  let kind: string | null = null
  if (kindRaw && kindRaw !== "all") {
    if (!VALID_KINDS.has(kindRaw)) {
      return NextResponse.json({ error: "invalid kind: " + kindRaw }, { status: 400 })
    }
    kind = kindRaw
  }

  // Wallet ownership check (same shape as /api/wallet/pack-history).
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
    .limit(1), "api/wallet/transaction-history/saved_wallets")

  if (lookupErr) {
    console.error("[wallet/transaction-history] verify lookup", lookupErr.message)
    return apiErrorResponse(lookupErr, "api/wallet/transaction-history");
  }
  if (!matches || matches.length === 0) {
    return NextResponse.json(
      { error: "wallet not saved on this account" },
      { status: 403 },
    )
  }

  try {
    const { data, error } = await boundedRead(sb.rpc("get_wallet_transaction_history", {
      p_wallet: wallet,
      p_limit: limit,
      p_offset: offset,
      p_kind: kind,
    }), "api/wallet/transaction-history/get_wallet_transaction_history")
    if (error) {
      console.error("[wallet/transaction-history]", error.message)
      return apiErrorResponse(error, "api/wallet/transaction-history");
    }
    return NextResponse.json(data ?? {}, {
      headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[wallet/transaction-history] unexpected", msg)
    return apiErrorResponse(err, "api/wallet/transaction-history");
  }
}
