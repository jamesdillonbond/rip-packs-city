// app/api/portfolio/history/route.ts
//
// Thin wrapper around get_portfolio_history(owner_key, days). Cookie-auth
// gated. owner_key is a wallet address keyed off saved_wallets — the
// client provides it (typically from rpc_owner_key in localStorage).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth/supabase-server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const url = req.nextUrl;
  const ownerKey = url.searchParams.get("owner_key")?.trim();
  if (!ownerKey) {
    return NextResponse.json({ error: "owner_key param required" }, { status: 400 });
  }

  const daysRaw = Number(url.searchParams.get("days") ?? 30);
  const days = Math.max(1, Math.min(365, isNaN(daysRaw) ? 30 : Math.floor(daysRaw)));

  const { data, error } = await supabaseAdmin.rpc("get_portfolio_history", {
    p_owner_key: ownerKey,
    p_days: days,
  });

  if (error) {
    console.log(`[portfolio/history] rpc error: ${error.message}`);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, days, history: data ?? [] });
}
