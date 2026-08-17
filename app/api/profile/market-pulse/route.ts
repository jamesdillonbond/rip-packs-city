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
    // ⚠ NULL, not 0. These two are counts of OUR OWN index, and a failed count
    // published as `0` is a claim that the index is empty — manufactured from our
    // own outage. Note the failure object at the bottom of this route already
    // returns `commonFloor: null` etc.: the route knew how to say "unknown" and
    // used it for the floors only.
    //   ⚠ supabase-js RETURNS errors rather than throwing, so the surrounding
    // `try/catch` never fires for the realistic failure (a 57014 statement
    // timeout) — which is exactly how `?? 0` hid this.
    //   ⚠ MEASURED, correcting the obvious reading of the fix: the `error ? null :`
    // branch below is REDUNDANT. A failed count nulls `count` too, so `count ??
    // null` alone already yields null, and a mutation dropping the error branch
    // SURVIVES the suite. The load-bearing change is `?? 0` -> `?? null`; the
    // branch is kept as intent, and becomes load-bearing only if a client ever
    // returns a count alongside an error.
    let snapshotsToday: number | null = null;
    try {
      if (collectionUuid) {
        // editions has collection_id; fmv_snapshots has edition_id. Use an
        // inner select so Supabase returns only rows whose edition belongs
        // to this collection. Read the exact `count` — NOT the returned rows'
        // length, which PostgREST clamps at 1,000: Top Shot computes ~4,200
        // snapshots/day and AllDay ~1,200, so the old `snaps.length` capped
        // this index-health number at exactly 1,000 (a silent ~4x undercount).
        const { count, error } = await (supabase as any)
          .from("fmv_snapshots")
          .select("edition_id, editions!inner(collection_id)", { count: "exact", head: true })
          .eq("editions.collection_id", collectionUuid)
          .gte("computed_at", new Date(Date.now() - 86400000).toISOString());
        snapshotsToday = error ? null : count ?? null;
      } else {
        const { count, error } = await supabase
          .from("fmv_snapshots")
          .select("*", { count: "exact", head: true })
          .gte("computed_at", new Date(Date.now() - 86400000).toISOString());
        snapshotsToday = error ? null : count ?? null;
      }
    } catch {
      // Non-fatal, but "we could not count" is NOT "there were none": leave null.
    }

    // Count editions indexed for this collection (not all editions).
    let indexedEditions: number | null = null;
    try {
      if (collectionUuid) {
        const { count, error } = await (supabase as any)
          .from("editions")
          .select("*", { count: "exact", head: true })
          .eq("collection_id", collectionUuid);
        indexedEditions = error ? null : count ?? null;
      } else {
        const { count, error } = await supabase
          .from("fmv_snapshots")
          .select("*", { count: "exact", head: true });
        indexedEditions = error ? null : count ?? null;
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
      // Consistent with the floors directly above: unknown reads as null.
      indexedEditions: null,
      snapshotsToday: null,
      updatedAt: new Date().toISOString(),
    });
  }
}
