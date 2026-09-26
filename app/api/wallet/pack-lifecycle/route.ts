// app/api/wallet/pack-lifecycle/route.ts
//
// GET /api/wallet/pack-lifecycle?wallet=<addr>&packNftId=<id>[&collection=<slug>]
//
// Auth: requires a Supabase user session; verifies the requested wallet
// belongs to the user. Backs the inline-expand row in /dashboard/packs by
// calling get_pack_lifecycle(p_pack_nft_id text). The public lifecycle page
// at /[collection]/pack/[id] is anon-safe, but the dashboard view is keyed
// to the signed-in user's wallets so we gate it the same way as the summary
// and history endpoints — defense-in-depth.
//
// 2026-09-26: the PULLS come from get_wallet_pack_pulls when `collection` is
// given — Dapper's list of what THIS pack yielded for THIS wallet, or the
// wallet's reconstructed rip (packNftId "burst:<nft>", which has no lifecycle
// of its own). get_pack_lifecycle's pull list joins moment_acquisitions on
// source_pack_rip_id and listed 95 "pulls" for a 3-moment pack, so it is kept
// only where its count equals the rip's moments_pulled; otherwise pulls are
// [] with pulls_source NULL — "not identified", never a guess.

import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";
import { supabaseAdmin } from "@/lib/supabase"
import { requireUser } from "@/lib/auth/supabase-server"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = supabaseAdmin

export async function GET(req: NextRequest) {
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }

  const wallet = (req.nextUrl.searchParams.get("wallet") ?? "").toLowerCase().trim()
  const packNftId = (req.nextUrl.searchParams.get("packNftId") ?? "").trim()
  const collection = (req.nextUrl.searchParams.get("collection") ?? "").trim()
  if (!wallet || !packNftId) {
    return NextResponse.json({ error: "wallet and packNftId required" }, { status: 400 })
  }

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
    .limit(1), "api/wallet/pack-lifecycle/saved-wallets")

  if (lookupErr) {
    return apiErrorResponse(lookupErr, "api/wallet/pack-lifecycle");
  }
  if (!matches || matches.length === 0) {
    return NextResponse.json({ error: "wallet not saved on this account" }, { status: 403 })
  }

  try {
    // A reconstructed rip is not a pack id: there is no lifecycle to read.
    const isBurst = packNftId.startsWith("burst:")
    let lifecycle: Record<string, unknown> = { pack_nft_id: packNftId, status: "ripped" }
    if (!isBurst) {
      const { data, error } = await boundedRead(sb.rpc("get_pack_lifecycle", { p_pack_nft_id: packNftId }), "api/wallet/pack-lifecycle/get_pack_lifecycle")
      if (error) {
        console.error("[wallet/pack-lifecycle]", error.message)
        return apiErrorResponse(error, "api/wallet/pack-lifecycle");
      }
      lifecycle = { ...(data ?? {}) }
    }

    let pullsSource: string | null = null
    let pullCounts: Record<string, unknown> = {}
    let walletPulls: unknown[] | null = null
    if (collection) {
      const { data: wp, error: wpErr } = await boundedRead(
        sb.rpc("get_wallet_pack_pulls", { p_wallet: wallet, p_collection_slug: collection, p_pack_nft_id: packNftId }),
        "api/wallet/pack-lifecycle/get_wallet_pack_pulls",
      )
      // A failed read must not fall back to the linkage it replaces.
      if (wpErr) {
        console.error("[wallet/pack-lifecycle] pulls", wpErr.message)
        return apiErrorResponse(wpErr, "api/wallet/pack-lifecycle");
      }
      if (wp && typeof wp === "object" && wp.source) {
        pullsSource = String(wp.source)
        walletPulls = Array.isArray(wp.pulls) ? wp.pulls : []
        pullCounts = { pulls_total: wp.pulls_total ?? null, pulls_identified: wp.pulls_identified ?? null, pulls_priced: wp.pulls_priced ?? null }
      }
    }

    if (walletPulls) {
      lifecycle.pulls = walletPulls
    } else {
      // Keep the lifecycle list only when it is the size of the pack.
      const pulls = Array.isArray(lifecycle.pulls) ? lifecycle.pulls : []
      const rip = lifecycle.rip as { moments_pulled?: number | null } | null | undefined
      const expected = typeof rip?.moments_pulled === "number" ? rip.moments_pulled : null
      if (pulls.length > 0 && expected != null && pulls.length === expected) {
        pullsSource = "rip_record"
      } else {
        lifecycle.pulls = []
      }
    }

    return NextResponse.json({ ...lifecycle, pulls_source: pullsSource, ...pullCounts }, {
      headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
    })
  } catch (err) {
    return apiErrorResponse(err, "api/wallet/pack-lifecycle");
  }
}
