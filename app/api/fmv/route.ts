// app/api/fmv/route.ts
// Public FMV API - single and batch edition lookup
// GET  /api/fmv?edition={setID:playID}[&serial=42]
// POST /api/fmv  { editions: [...], serial?: 42 }

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SERIES_NAMES: Record<number, string> = {
  0: "Beta", 1: "S1", 2: "S2", 3: "S3",
  4: "S4", 5: "S5", 6: "S6", 7: "S7", 8: "S8",
};

const BADGE_PREMIUMS: Record<string, number> = {
  "Rookie Year": 0.45, "Rookie Mint": 0.35, "Rookie Premiere": 0.30,
  "Top Shot Debut": 0.25, "Three-Star Rookie": 0.20, "MVP Year": 0.20,
  "Championship Year": 0.18, "Rookie of the Year": 0.18, "Fresh": 0.10, "Autograph": 0.60,
};

function serialMultiplier(serial: number, circ: number): number {
  if (serial === 1) return 12.0;
  if (serial <= 10) return 4.5;
  if (serial <= 23) return 2.8;
  if (serial === circ) return 3.0;
  return Math.max(1.0, Math.pow(circ / 2 / serial, 0.4));
}

function r2(n: number) { return Math.round(n * 100) / 100; }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function lookupEditions(supabase: any, editionKeys: string[], serial?: number) {
  if (!editionKeys.length) return [];

  // Step 1: resolve external_id → internal UUID (editions table only has id + external_id)
  const { data: editionRows, error: edErr } = await supabase
    .from("editions")
    .select("id, external_id")
    .in("external_id", editionKeys);

  if (edErr) throw new Error(`editions lookup: ${edErr.message}`);

  const extToId = new Map<string, string>();
  const idToExt = new Map<string, string>();
  for (const row of (editionRows ?? [])) {
    extToId.set(row.external_id, row.id);
    idToExt.set(row.id, row.external_id);
  }

  const internalIds = Array.from(extToId.values());

  // Step 2: fetch FMV snapshots — columns: edition_id, fmv_usd, confidence, computed_at
  const fmvMap = new Map<string, { fmv_usd: number; confidence: string; computed_at: string }>();
  if (internalIds.length) {
    const { data: fmvRows } = await supabase
      .from("fmv_snapshots")
      .select("edition_id, fmv_usd, confidence, computed_at")
      .in("edition_id", internalIds)
      .order("computed_at", { ascending: false });

    for (const row of (fmvRows ?? [])) {
      if (!fmvMap.has(row.edition_id)) fmvMap.set(row.edition_id, row);
    }
  }

  // Step 3: fetch badge premiums via badge_editions table
  // badge_editions has: player_name, badge_type, series_number, set_id, play_id (or similar)
  // We join via editionKey (setID:playID) → need to check what badge_editions actually has
  // For now, build badge map keyed by edition internal ID if possible
  // badge_editions uses series_number + player matching — skip for now, return 0 badge premium
  // TODO: wire badge premium when we confirm badge_editions schema joins to editions

  return editionKeys.map(externalId => {
    const internalId = extToId.get(externalId);

    if (!internalId) {
      return { edition: externalId, fmv: 0, serialMult: null, badgePremiumPct: 0, adjustedFmv: 0, confidence: "unknown", updatedAt: null, error: "Edition not found" };
    }

    const fmv = fmvMap.get(internalId);
    if (!fmv) {
      return { edition: externalId, fmv: 0, serialMult: null, badgePremiumPct: 0, adjustedFmv: 0, confidence: "unknown", updatedAt: null, error: "No FMV data yet" };
    }

    const baseFmv = fmv.fmv_usd;
    const mult = serial != null ? serialMultiplier(serial, 1000) : null; // circ unknown without metadata
    const adjustedFmv = mult != null ? baseFmv * mult : baseFmv;
    const confidence = (fmv.confidence ?? "low").toLowerCase();

    return {
      edition: externalId,
      fmv: r2(baseFmv),
      serialMult: mult != null ? r2(mult) : null,
      badgePremiumPct: 0, // TODO: wire badge data
      adjustedFmv: r2(adjustedFmv),
      confidence,
      updatedAt: fmv.computed_at,
    };
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const edition = url.searchParams.get("edition");
  const serialParam = url.searchParams.get("serial");
  const serial = serialParam ? parseInt(serialParam, 10) : undefined;

  if (!edition) {
    return NextResponse.json({
      error: "Missing required parameter: edition",
      usage: {
        single: "GET /api/fmv?edition={setID:playID}[&serial=42]",
        batch:  "POST /api/fmv  { editions: ['...'], serial?: 42 }",
        demo:   "GET /api/fmv/demo",
      },
    }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: any = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  try {
    const results = await lookupEditions(supabase, [edition], serial);
    const result = results[0];
    const status = result?.error === "Edition not found" ? 404 : 200;
    return NextResponse.json(result, {
      status,
      headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let body: { editions?: string[]; serial?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const { editions, serial } = body;
  if (!editions || !Array.isArray(editions) || editions.length === 0)
    return NextResponse.json({ error: "Body must contain non-empty editions array" }, { status: 400 });
  if (editions.length > 100)
    return NextResponse.json({ error: "Maximum 100 editions per batch request" }, { status: 400 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: any = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  try {
    const results = await lookupEditions(supabase, editions, serial);
    return NextResponse.json(
      { count: results.length, results },
      { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=60" } }
    );
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}