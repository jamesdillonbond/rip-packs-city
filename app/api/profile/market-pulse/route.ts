import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase: any = createClient(
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
    // fmv_snapshots has: edition_id (UUID FK), fmv_usd, confidence (enum), computed_at
    // We need to join editions to get tier info — but editions only has id + external_id.
    // Instead, pull raw FMV data and count indexed editions.
    const { data: snapshots } = await supabase
      .from("fmv_snapshots")
      .select("fmv_usd, computed_at")
      .gte("computed_at", new Date(Date.now() - 86400000).toISOString())
      .order("computed_at", { ascending: false })
      .limit(500);

    const rows = snapshots ?? [];

    // Count active editions indexed
    const { count: editionCount } = await supabase
      .from("fmv_snapshots")
      .select("*", { count: "exact", head: true });

    // Without tier data on fmv_snapshots, pull floor prices from cached_listings if available
    let commonFloor: number | null = null;
    let rareFloor: number | null = null;
    let legendaryFloor: number | null = null;

    try {
      const { data: listings } = await supabase
        .from("cached_listings")
        .select("tier, ask_price")
        .in("tier", ["COMMON", "RARE", "LEGENDARY"])
        .gt("ask_price", 0)
        .order("ask_price", { ascending: true })
        .limit(500);

      if (listings && listings.length > 0) {
        const byTier: Record<string, number[]> = {};
        for (const l of listings) {
          const t = (l.tier ?? "").toUpperCase();
          if (!byTier[t]) byTier[t] = [];
          byTier[t].push(Number(l.ask_price));
        }
        commonFloor = byTier["COMMON"]?.[0] ?? null;
        rareFloor = byTier["RARE"]?.[0] ?? null;
        legendaryFloor = byTier["LEGENDARY"]?.[0] ?? null;
      }
    } catch {
      // cached_listings may not exist — that's OK
    }

    const result = {
      commonFloor,
      rareFloor,
      legendaryFloor,
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