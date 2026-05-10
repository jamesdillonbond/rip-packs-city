// app/api/admin/fmv-health/route.ts
//
// GET /api/admin/fmv-health?windowHours=24&limit=50
// Authorization: Bearer <RPC_ADMIN_TOKEN | INGEST_SECRET_TOKEN>
//
// Surfaces the thin-sales guard cap audit (get_fmv_calibration_caps_summary)
// for /admin/fmv-health. Window selector accepts 1, 24, 168, 720 hours
// (mapped from "1h" / "24h" / "7d" / "30d" on the client).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

const VALID_WINDOWS = new Set([1, 24, 168, 720]);

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const ingest = process.env.INGEST_SECRET_TOKEN;
  const admin = process.env.RPC_ADMIN_TOKEN;
  if (ingest && auth === `Bearer ${ingest}`) return true;
  if (admin && auth === `Bearer ${admin}`) return true;
  return false;
}

interface CapRow {
  edition_id: string;
  player_name: string | null;
  set_name: string | null;
  tier: string | null;
  collection_slug: string | null;
  reason: string | null;
  fmv_before: number | null;
  fmv_after: number | null;
  pct_dropped: number | null;
  confidence_before: string | null;
  confidence_after: string | null;
  applied_at: string | null;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const windowHoursRaw = Number(req.nextUrl.searchParams.get("windowHours") ?? 24);
  const windowHours = VALID_WINDOWS.has(windowHoursRaw) ? windowHoursRaw : 24;
  const limit = Math.min(
    Math.max(Number(req.nextUrl.searchParams.get("limit") ?? 50), 1),
    500
  );

  const { data, error } = await (supabaseAdmin as any).rpc(
    "get_fmv_calibration_caps_summary",
    { p_window_hours: windowHours, p_limit: limit }
  );

  if (error) {
    return NextResponse.json(
      { error: error.message, code: (error as { code?: string }).code ?? null },
      { status: 500 }
    );
  }

  const rows = (Array.isArray(data) ? data : []) as CapRow[];

  // Stat strip — total caps in window, broken down by reason.
  const reasonCounts: Record<string, number> = {};
  for (const r of rows) {
    const k = (r.reason ?? "unknown").toString();
    reasonCounts[k] = (reasonCounts[k] ?? 0) + 1;
  }

  return NextResponse.json({
    window_hours: windowHours,
    generated_at: new Date().toISOString(),
    total_caps: rows.length,
    by_reason: reasonCounts,
    rows,
  });
}
