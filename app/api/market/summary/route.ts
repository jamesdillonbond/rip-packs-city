// app/api/market/summary/route.ts
//
// Thin wrapper around get_market_summary(). Cookie-auth gated.

import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";
import { supabaseAdmin } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth/supabase-server";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { data, error } = await boundedRead(supabaseAdmin.rpc("get_market_summary"), "api/market/summary/get_market_summary");
  if (error) {
    console.log(`[market/summary] rpc error: ${error.message}`);
    return apiErrorResponse(error, "api/market/summary");
  }

  return NextResponse.json({ ok: true, summary: data ?? {} });
}
