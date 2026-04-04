import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

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
  const { data } = await supabase
    .from("fmv_snapshots")
    .select("edition_id, fmv_usd, computed_at")
    .in("edition_id", editionIds)
    .gte("computed_at", since)
    .order("computed_at", { ascending: true });

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
