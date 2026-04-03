// app/api/watchlist/route.ts
// GET    /api/watchlist?owner_key=X — fetch watchlist with FMV, low_ask, discount, alert status
// POST   /api/watchlist — upsert a watchlist row
// DELETE /api/watchlist — remove a watchlist row

export const maxDuration = 10;

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(req: NextRequest) {
  const owner_key = req.nextUrl.searchParams.get("owner_key");
  if (!owner_key) {
    return NextResponse.json({ error: "Missing required parameter: owner_key" }, { status: 400 });
  }

  try {
    // Fetch all watchlist rows for this owner
    const { data: rows, error } = await supabase
      .from("watchlist")
      .select("*")
      .eq("owner_key", owner_key)
      .order("added_at", { ascending: false });

    if (error) throw new Error(error.message);
    if (!rows || rows.length === 0) return NextResponse.json([]);

    // Gather unique edition_keys for batch lookups
    const editionKeys = rows.map((r: any) => r.edition_key);

    // Fetch edition internal IDs
    const { data: editionRows } = await supabase
      .from("editions")
      .select("id, external_id")
      .in("external_id", editionKeys);

    const extToId = new Map<string, string>();
    for (const row of editionRows ?? []) {
      extToId.set(row.external_id, row.id);
    }

    // Fetch latest FMV snapshots for each edition
    const internalIds = Array.from(extToId.values());
    const fmvMap = new Map<string, number>();
    if (internalIds.length) {
      const { data: fmvRows } = await supabase
        .from("fmv_snapshots")
        .select("edition_id, fmv_usd, computed_at")
        .in("edition_id", internalIds)
        .order("computed_at", { ascending: false });

      for (const row of fmvRows ?? []) {
        if (!fmvMap.has(row.edition_id)) fmvMap.set(row.edition_id, row.fmv_usd);
      }
    }

    // Fetch low_ask from badge_editions for each edition_key
    const { data: badgeRows } = await supabase
      .from("badge_editions")
      .select("edition_key, low_ask")
      .in("edition_key", editionKeys);

    const lowAskMap = new Map<string, number>();
    for (const row of badgeRows ?? []) {
      if (row.low_ask != null) {
        // Keep the lowest low_ask per edition_key
        const existing = lowAskMap.get(row.edition_key);
        if (existing == null || row.low_ask < existing) {
          lowAskMap.set(row.edition_key, row.low_ask);
        }
      }
    }

    // Check active alerts for this owner
    const { data: alertRows } = await supabase
      .from("fmv_alerts")
      .select("edition_key")
      .eq("owner_key", owner_key)
      .eq("active", true);

    const alertSet = new Set<string>();
    for (const row of alertRows ?? []) {
      alertSet.add(row.edition_key);
    }

    // Enrich each watchlist row
    const enriched = rows.map((row: any) => {
      const internalId = extToId.get(row.edition_key);
      const fmv = internalId ? fmvMap.get(internalId) ?? null : null;
      const low_ask = lowAskMap.get(row.edition_key) ?? null;
      const discount_pct =
        fmv != null && low_ask != null && fmv > 0
          ? Math.round(((fmv - low_ask) / fmv) * 100)
          : null;
      const has_alert = alertSet.has(row.edition_key);

      return { ...row, fmv, low_ask, discount_pct, has_alert };
    });

    return NextResponse.json(enriched);
  } catch (err: any) {
    console.error("[watchlist GET]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { owner_key, edition_key, player_name, set_name, series_number, tier, thumbnail_url, notes } = body;

    if (!owner_key) {
      return NextResponse.json({ error: "Missing required field: owner_key" }, { status: 400 });
    }
    if (!edition_key) {
      return NextResponse.json({ error: "Missing required field: edition_key" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("watchlist")
      .upsert(
        {
          owner_key,
          edition_key,
          player_name,
          set_name,
          series_number: series_number ?? null,
          tier: tier ?? null,
          thumbnail_url: thumbnail_url ?? null,
          notes: notes ?? null,
        },
        { onConflict: "owner_key,edition_key" }
      )
      .select()
      .single();

    if (error) throw new Error(error.message);

    return NextResponse.json(data, { status: 201 });
  } catch (err: any) {
    console.error("[watchlist POST]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json();
    const { owner_key, edition_key } = body;

    if (!owner_key) {
      return NextResponse.json({ error: "Missing required field: owner_key" }, { status: 400 });
    }
    if (!edition_key) {
      return NextResponse.json({ error: "Missing required field: edition_key" }, { status: 400 });
    }

    const { error } = await supabase
      .from("watchlist")
      .delete()
      .eq("owner_key", owner_key)
      .eq("edition_key", edition_key);

    if (error) throw new Error(error.message);

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("[watchlist DELETE]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
