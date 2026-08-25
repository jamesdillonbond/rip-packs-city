// app/api/pro-status/route.ts
// GET /api/pro-status?wallet=0x... — returns Pro status via is_pro_user RPC

import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"

// ⚠ WHY THE FAILURE PATHS ARE NOT `is_pro: false` (fixed 2026-08-25).
//
// Every failure here used to answer 200 with `{ is_pro: false, plan: null,
// days_remaining: 0 }` — a confident claim about the READER'S OWN PAID STATUS,
// manufactured from a read that did not happen. CLAUDE.md names that the worst
// sub-class: a false claim about the reader's own account.
//
// It is not hypothetical. `pro_users` holds 21 rows, all active today, on two
// plans (`founding`, `pro_grandfather`). The chain is
// useSessionOwner → useProStatus(walletAddr) → ProBadge, and `ProBadge` renders
// `null` when `!isPro` — so one database hiccup silently removed the PRO /
// FOUNDING badge site-wide (GlobalSiteHeader, /my-teams, /analytics) for real
// paying members, and `useProStatus` then CACHED that for five minutes.
//
// ⭐ /api/profile/me's own header already describes this exact chain —
// "a failed read takes the PRO badge away from a paying member" — and that
// route was fixed. This one, one link further down the same chain, was not.
// Same defect, different file: grep the EXPRESSION, not the file.
export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim().toLowerCase()
  if (!wallet) {
    // A genuine, established answer: no wallet on the request means nothing to
    // look up. This one IS a true statement and stays a 200.
    return NextResponse.json({ is_pro: false, plan: null, expires_at: null, days_remaining: 0 })
  }

  try {
    const { data, error } = await (supabaseAdmin as any).rpc("is_pro_user", { p_wallet: wallet })
    if (error) {
      return apiErrorResponse(error, "api/pro-status", "Could not check membership status right now.")
    }
    if (!data) {
      // Read from live prosrc rather than assumed: `is_pro_user` ends in a
      // COALESCE onto `jsonb_build_object('is_pro', false, ...)`, so a wallet
      // with no `pro_users` row returns that OBJECT, never NULL. A null here is
      // therefore a broken RPC, not a non-member — and answering "not Pro" from
      // it would be the same fabricated claim by a quieter route.
      return apiErrorResponse(
        new Error("is_pro_user returned null, which its definition cannot produce"),
        "api/pro-status",
        "Could not check membership status right now."
      )
    }
    return NextResponse.json({
      is_pro: !!data.is_pro,
      plan: data.plan ?? null,
      expires_at: data.expires_at ?? null,
      days_remaining: Number(data.days_remaining ?? 0),
    })
  } catch (err) {
    return apiErrorResponse(err, "api/pro-status", "Could not check membership status right now.")
  }
}
