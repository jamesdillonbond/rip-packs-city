// app/api/market/summary/route.ts
//
// Thin wrapper around get_market_summary(). Cookie-auth gated.

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth/supabase-server";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin.rpc("get_market_summary");
  if (error) {
    console.log(`[market/summary] rpc error: ${error.message}`);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, summary: data ?? {} });
}
