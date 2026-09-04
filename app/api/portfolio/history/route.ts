// app/api/portfolio/history/route.ts
//
// Thin wrapper around get_portfolio_history(owner_key, days). Cookie-auth
// gated. owner_key is a wallet address keyed off saved_wallets — the
// client provides it (typically from rpc_owner_key in localStorage).

import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";
import { supabaseAdmin } from "@/lib/supabase";
import { requireOwnedKey } from "@/lib/auth/owner-key-guard";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const ownerKey = url.searchParams.get("owner_key")?.trim();
  if (!ownerKey) {
    return NextResponse.json({ error: "owner_key param required" }, { status: 400 });
  }

  // owner_key is client-controlled (rpc_owner_key from localStorage) and the RPC
  // below runs on the service-role client (bypasses RLS), so prove the key
  // belongs to the authenticated caller — otherwise any signed-in user could
  // read another wallet's portfolio history. (401 unauth / 403 not-yours.)
  const gate = await requireOwnedKey(ownerKey);
  if (gate instanceof Response) return gate;

  const daysRaw = Number(url.searchParams.get("days") ?? 30);
  const days = Math.max(1, Math.min(365, isNaN(daysRaw) ? 30 : Math.floor(daysRaw)));

  const { data, error } = await boundedRead(supabaseAdmin.rpc("get_portfolio_history", {
    p_owner_key: ownerKey,
    p_days: days,
  }), "api/portfolio/history/get_portfolio_history");

  if (error) {
    console.log(`[portfolio/history] rpc error: ${error.message}`);
    return apiErrorResponse(error, "api/portfolio/history");
  }

  return NextResponse.json({ ok: true, days, history: data ?? [] });
}
