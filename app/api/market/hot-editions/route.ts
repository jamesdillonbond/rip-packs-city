// app/api/market/hot-editions/route.ts
//
// Thin wrapper around get_hot_editions_24h(slug, limit). Cookie-auth gated;
// proxy.ts already enforces the allow_list check upstream, but we double-
// check getCurrentUser here so the route is safe to expose directly.

import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";
import { supabaseAdmin } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth/supabase-server";

export const dynamic = "force-dynamic";

const VALID_SLUGS = new Set([
  "nba_top_shot",
  "nfl_all_day",
  "laliga_golazos",
  "disney_pinnacle",
  "ufc_strike",
]);

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const url = req.nextUrl;
  const rawSlug = url.searchParams.get("slug");
  const slug = rawSlug && VALID_SLUGS.has(rawSlug) ? rawSlug : null;
  const limitRaw = Number(url.searchParams.get("limit") ?? 10);
  const limit = Math.max(1, Math.min(50, isNaN(limitRaw) ? 10 : Math.floor(limitRaw)));

  const { data, error } = await boundedRead(supabaseAdmin.rpc("get_hot_editions_24h", {
    p_collection_slug: slug,
    p_limit: limit,
  }), "api/market/hot-editions/get_hot_editions_24h");

  if (error) {
    console.log(`[market/hot-editions] rpc error: ${error.message}`);
    return apiErrorResponse(error, "api/market/hot-editions");
  }

  return NextResponse.json({ ok: true, slug, limit, editions: data ?? [] });
}
