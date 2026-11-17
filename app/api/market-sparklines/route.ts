import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(req: NextRequest) {
  const editionIdsStr = req.nextUrl.searchParams.get("editionIds") ?? "";
  const editionIds = editionIdsStr.split(",").filter(Boolean).slice(0, 50);
  if (!editionIds.length) {
    return NextResponse.json({ sparklines: {} });
  }

  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  // ⚠ HONESTY CANON. This read used to destructure only `data`. supabase-js
  // RESOLVES on a query error, so a failed read left `data` null, the `if
  // (data)` below did nothing, and the route answered `{ sparklines: {} }` at
  // HTTP 200 under `s-maxage=300` — every caller then draws a flat/absent
  // 7-day line, which is a claim that these editions did not move, cached at
  // the CDN for five minutes. "Read failed" and "no snapshots in 7 days" are
  // different answers and must not share one.
  const { data, error } = await boundedRead(supabase
    .from("fmv_snapshots")
    .select("edition_id, fmv_usd, computed_at")
    .in("edition_id", editionIds)
    .gte("computed_at", since)
    .order("computed_at", { ascending: true }), "api/market-sparklines/fmv_snapshots");

  if (error) return apiErrorResponse(error, "api/market-sparklines");

  const sparklines: Record<string, number[]> = {};
  if (data) {
    for (const row of data) {
      if (!sparklines[row.edition_id]) sparklines[row.edition_id] = [];
      sparklines[row.edition_id].push(Number(row.fmv_usd));
    }
  }

  return NextResponse.json({ sparklines }, {
    headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
  });
}
