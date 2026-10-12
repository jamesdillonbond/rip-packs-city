import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// GET /api/admin/analytics-overview
// Authorization: Bearer <INGEST_SECRET_TOKEN | RPC_ADMIN_TOKEN>
//
// Thin wrapper around the SECDEF RPC get_admin_analytics_overview().
// The RPC is granted to service_role only, so we proxy through supabaseAdmin.
//
// 2026-10-11 (platform review M3): ALSO reads get_rpc_traction_activity() —
// WAU / MAU / signups / D7+D30 return, all excluding internal_accounts (migration
// 20261012053500) — and attaches it as `traction`. The two reads are INDEPENDENT:
// a failure of the second never fails the overview; it is reported as
// `traction: null, traction_error: <message>` so the client can show "—" WITH
// the reason rather than a 0. (This is an operator route behind a shared secret,
// the one place CLAUDE.md allows a driver message through.)

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
    const [overview, traction] = await Promise.all([
      supabaseAdmin.rpc("get_admin_analytics_overview"),
      supabaseAdmin.rpc("get_rpc_traction_activity"),
    ]);
    if (overview.error) {
      console.log(`[admin-analytics-overview] rpc error: ${overview.error.message}`);
      return NextResponse.json({ error: overview.error.message }, { status: 500 });
    }
    const base = (overview.data ?? {}) as Record<string, unknown>;
    if (traction.error) {
      console.log(`[admin-analytics-overview] traction rpc error: ${traction.error.message}`);
      return NextResponse.json({ ...base, traction: null, traction_error: traction.error.message });
    }
    // `traction.data` may be null if the function is not yet applied; the client
    // renders an absent block as "—" and says so.
    return NextResponse.json({ ...base, traction: traction.data ?? null, traction_error: traction.data ? null : "traction snapshot returned no payload" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[admin-analytics-overview] fatal: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
