import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/auth/bearer-secret";
import { supabaseAdmin } from "@/lib/supabase";

// GET /api/admin/listing-retry-queue
// Authorization: Bearer <INGEST_SECRET_TOKEN | RPC_ADMIN_TOKEN>
//
// Thin wrapper around the SECDEF RPC get_listing_retry_queue_stats().
// Renders the panel data for /admin/listing-retry-queue.

export const maxDuration = 30;
export const dynamic = "force-dynamic";

function isAuthorized(req: NextRequest): boolean {
  // Constant-time, fail-closed (lib/auth/bearer-secret.ts; security audit 2026-10-25, R134 step 1).
  return bearerMatches(req.headers.get("authorization"), "INGEST_SECRET_TOKEN", "RPC_ADMIN_TOKEN");
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { data, error } = await supabaseAdmin.rpc("get_listing_retry_queue_stats");
    if (error) {
      console.log(`[admin-listing-retry-queue] rpc error: ${error.message}`);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json(data ?? {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[admin-listing-retry-queue] fatal: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
