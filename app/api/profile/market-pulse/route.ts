// app/api/profile/market-pulse/route.ts
//
// Per-collection market pulse — floor prices by tier + index health.
// Phase 2: accepts ?collectionId=<slug> and scopes BOTH the fmv_snapshots
// count and the cached_listings floor queries by that collection. Prior
// implementation had no collection filter, which is why Pinnacle and
// Golazos overviews looked wrong (Top Shot numbers leaked through).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { getCollection, COLLECTION_UUID_BY_SLUG } from "@/lib/collections";

// In-memory cache keyed by collectionId — 60s TTL.
const cache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL = 60_000;

export async function GET(req: NextRequest) {
  const collectionId = req.nextUrl.searchParams.get("collectionId") ?? "nba-top-shot";
  const collection = getCollection(collectionId);
  const collectionUuid =
    collection?.supabaseCollectionId ?? COLLECTION_UUID_BY_SLUG[collectionId] ?? null;

  const cached = cache.get(collectionId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json(cached.data);
  }

  try {
    // FMV snapshots in last 24h. When we know the collection uuid, join through
    // editions via edition_id; otherwise return the global count for back-compat.
    let snapshotsToday = 0;
    try {
      if (collectionUuid) {
        // editions has collection_id; fmv_snapshots has edition_id. Use an
        // inner select so Supabase returns only rows whose edition belongs
        // to this collection.
        const { data: snaps } = await (supabase as any)
          .from("fmv_snapshots")
          .select("edition_id, editions!inner(collection_id)", { count: "exact", head: false })
          .eq("editions.collection_id", collectionUuid)
          .gte("computed_at", new Date(Date.now() - 86400000).toISOString())
          .limit(1000);
        snapshotsToday = Array.isArray(snaps) ? snaps.length : 0;
      } else {
        const { count } = await supabase
          .from("fmv_snapshots")
          .select("*", { count: "exact", head: true })
          .gte("computed_at", new Date(Date.now() - 86400000).toISOString());
        snapshotsToday = count ?? 0;
      }
    } catch {
      // non-fatal; keep snapshotsToday=0
    }

    // Count editions indexed for this collection (not all editions).
    let indexedEditions = 0;
    try {
      if (collectionUuid) {
        const { count } = await (supabase as any)
          .from("editions")
          .select("*", { count: "exact", head: true })
          .eq("collection_id", collectionUuid);
        indexedEditions = count ?? 0;
      } else {
        const { count } = await supabase
          .from("fmv_snapshots")
          .select("*", { count: "exact", head: true });
        indexedEditions = count ?? 0;
      }
    } catch {
      // non-fatal
    }

    // Floor prices from cached_listings — scoped to the active collection.
    // Tier names are collection-dependent; we look up the three canonical
    // TopShot/AllDay tiers, and for thin-volume collections (Golazos, Pinnacle)
    // return the lowest ask regardless of tier for each column.
    let commonFloor: number | null = null;
    let rareFloor: number | null = null;
    let legendaryFloor: number | null = null;

    try {
      let q = (supabase as any)
        .from("cached_listings")
        .select("tier, ask_price")
        .gt("ask_price", 0)
        .order("ask_price", { ascending: true })
        .limit(500);

      if (collectionUuid) q = q.eq("collection_id", collectionUuid);

      const { data: listings } = await q;
      if (listings && listings.length > 0) {
        const byTier: Record<string, number[]> = {};
        for (const l of listings) {
          const t = String(l.tier ?? "").toUpperCase();
          if (!byTier[t]) byTier[t] = [];
          byTier[t].push(Number(l.ask_price));
        }
        commonFloor = byTier["COMMON"]?.[0] ?? byTier["FANDOM"]?.[0] ?? null;
        rareFloor = byTier["RARE"]?.[0] ?? byTier["UNCOMMON"]?.[0] ?? null;
        legendaryFloor = byTier["LEGENDARY"]?.[0] ?? byTier["ULTIMATE"]?.[0] ?? null;
      }
    } catch {
      // cached_listings may not exist — that's OK
    }

    const result = {
      collectionId,
      commonFloor,
      rareFloor,
      legendaryFloor,
      indexedEditions,
      snapshotsToday,
      updatedAt: new Date().toISOString(),
    };

    cache.set(collectionId, { data: result, ts: Date.now() });
    return NextResponse.json(result);
  } catch (err) {
    console.error(`[market-pulse:${collectionId}]`, err);
    return NextResponse.json({
      collectionId,
      commonFloor: null,
      rareFloor: null,
      legendaryFloor: null,
      indexedEditions: 0,
      snapshotsToday: 0,
      updatedAt: new Date().toISOString(),
    });
  }
}
