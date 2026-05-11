import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// GET /api/admin/analytics-overview
// Authorization: Bearer <INGEST_SECRET_TOKEN | RPC_ADMIN_TOKEN>
//
// Thin wrapper around the SECDEF RPC get_admin_analytics_overview().
// The RPC is granted to service_role only, so we proxy through supabaseAdmin.

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

  try {
    const { data, error } = await supabaseAdmin.rpc("get_admin_analytics_overview");
    if (error) {
      console.log(`[admin-analytics-overview] rpc error: ${error.message}`);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json(data ?? {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[admin-analytics-overview] fatal: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
