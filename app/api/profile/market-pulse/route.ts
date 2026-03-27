import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Simple in-memory cache - 60 second TTL
let cache: { data: any; ts: number } | null = null;
const CACHE_TTL = 60_000;

export async function GET(req: NextRequest) {
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return NextResponse.json(cache.data);
  }

  try {
    // Pull recent fmv_snapshots for volume proxy and floor data
    const { data: snapshots } = await supabase
      .from("fmv_snapshots")
      .select("fmv, tier, updated_at")
      .gte("updated_at", new Date(Date.now() - 86400000).toISOString())
      .order("updated_at", { ascending: false })
      .limit(500);

    const rows = snapshots ?? [];

    // Compute stats from snapshot data
    const commonRows = rows.filter(function(r: any) { return r.tier === "Common"; });
    const rareRows = rows.filter(function(r: any) { return r.tier === "Rare"; });
    const legendaryRows = rows.filter(function(r: any) { return r.tier === "Legendary"; });

    const commonFloor = commonRows.length > 0
      ? Math.min(...commonRows.map(function(r: any) { return Number(r.fmv) || 9999; }))
      : null;
    const rareFloor = rareRows.length > 0
      ? Math.min(...rareRows.map(function(r: any) { return Number(r.fmv) || 9999; }))
      : null;
    const legendaryFloor = legendaryRows.length > 0
      ? Math.min(...legendaryRows.map(function(r: any) { return Number(r.fmv) || 9999; }))
      : null;

    // Count active editions indexed (proxy for market activity)
    const { count: editionCount } = await supabase
      .from("fmv_snapshots")
      .select("*", { count: "exact", head: true });

    const result = {
      commonFloor: commonFloor !== 9999 ? commonFloor : null,
      rareFloor: rareFloor !== 9999 ? rareFloor : null,
      legendaryFloor: legendaryFloor !== 9999 ? legendaryFloor : null,
      indexedEditions: editionCount ?? 0,
      snapshotsToday: rows.length,
      updatedAt: new Date().toISOString(),
    };

    cache = { data: result, ts: Date.now() };
    return NextResponse.json(result);
  } catch (err) {
    console.error("[market-pulse]", err);
    return NextResponse.json({
      commonFloor: null,
      rareFloor: null,
      legendaryFloor: null,
      indexedEditions: 0,
      snapshotsToday: 0,
      updatedAt: new Date().toISOString(),
    });
  }
}