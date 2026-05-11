import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// GET /api/admin/listing-retry-queue/rows
//   ?collection=nfl_all_day&min_retry_count=0&limit=100&offset=0
// Authorization: Bearer <INGEST_SECRET_TOKEN | RPC_ADMIN_TOKEN>
//
// Thin wrapper around the SECDEF RPC get_listing_retry_queue_rows().
// Drives the per-row table on /admin/listing-retry-queue.

export const maxDuration = 30;
export const dynamic = "force-dynamic";

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const ingest = process.env.INGEST_SECRET_TOKEN;
  const admin = process.env.RPC_ADMIN_TOKEN;
  if (ingest && auth === `Bearer ${ingest}`) return true;
  if (admin && auth === `Bearer ${admin}`) return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const collection = url.searchParams.get("collection");
  const minRetry = Number(url.searchParams.get("min_retry_count") ?? 0);
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
  try {
    const { data, error } = await supabaseAdmin.rpc("get_listing_retry_queue_rows", {
      p_collection_slug: collection && collection !== "all" ? collection : null,
      p_min_retry_count: Number.isFinite(minRetry) ? minRetry : 0,
      p_limit: limit,
      p_offset: offset,
    });
    if (error) {
      console.log(`[admin-listing-retry-rows] rpc error: ${error.message}`);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ rows: data ?? [], limit, offset });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
