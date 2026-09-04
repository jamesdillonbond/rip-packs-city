// app/api/market/whale-watch/route.ts
//
// Thin wrapper around get_whale_watch_7d(slug, limit). Cookie-auth gated.

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

  const { data, error } = await boundedRead(supabaseAdmin.rpc("get_whale_watch_7d", {
    p_collection_slug: slug,
    p_limit: limit,
  }), "api/market/whale-watch/get_whale_watch_7d");

  if (error) {
    console.log(`[market/whale-watch] rpc error: ${error.message}`);
    return apiErrorResponse(error, "api/market/whale-watch");
  }

  return NextResponse.json({ ok: true, slug, limit, whales: data ?? [] });
}
