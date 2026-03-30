// app/api/fmv/route.ts
//
// Public FMV API for RIP PACKS CITY
// ------------------------------------
// Single:  GET  /api/fmv?edition={setID:playID}[&serial=42]
// Batch:   POST /api/fmv  { "editions": ["setID:playID", ...], "serial": 42 }
//
// Optional auth: X-RPC-API-Key header (for partners — higher rate limits in future)
// Without auth: fully public, Vercel edge caching applies
//
// Response shape:
// {
//   edition:         "setID:playID"
//   playerName:      "Victor Wembanyama"
//   setName:         "Extra Spice"
//   seriesName:      "S8"
//   tier:            "COMMON"
//   circulationCount: 1149
//   fmv:             3.00          // base edition FMV (unadjusted)
//   serialMult:      1.88          // if serial param provided
//   badgePremiumPct: 173           // total badge premium %
//   adjustedFmv:     8.58          // fmv * serialMult * (1 + badgePremiumPct/100)
//   confidence:      "high"        // low | medium | high
//   updatedAt:       "2026-03-30T..."
//   source:          "livetoken"   // data source
// }

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

function round2(n: number) { return Math.round(n * 100) / 100; }

interface EditionRow {
  id: string;
  external_id: string;
  player_name: string | null;
  set_name: string | null;
  series_number: number | null;
  tier: string | null;
  circulation_count: number | null;
}

interface FmvRow {
  edition_id: string;
  fmv_usd: number;
  confidence: string;
  computed_at: string;
  source?: string;
}

interface BadgeRow {
  player_name: string;
  badge_type: string;
  series_number: number;
}

interface FmvResult {
  edition: string;
  playerName: string | null;
  setName: string | null;
  seriesName: string | null;
  tier: string | null;
  circulationCount: number | null;
  fmv: number;
  serialMult: number | null;
  badgePremiumPct: number;
  adjustedFmv: number;
  confidence: string;
  updatedAt: string | null;
  source: string;
  error?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function lookupEditions(
  supabase: any,
  editionKeys: string[],
  serial?: number
): Promise<FmvResult[]> {
  if (!editionKeys.length) return [];

  // 1. Resolve external_id → internal UUID
  const { data: editionRows, error: edErr } = await supabase
    .from("editions")
    .select("id, external_id, player_name, set_name, series_number, tier, circulation_count")
    .in("external_id", editionKeys);

  if (edErr) throw new Error(`editions lookup: ${edErr.message}`);

  const editionMap = new Map<string, EditionRow>();
  const internalIds: string[] = [];
  for (const row of (editionRows ?? []) as EditionRow[]) {
    editionMap.set(row.external_id, row);
    internalIds.push(row.id);
  }

  // 2. Fetch FMV snapshots
  const fmvMap = new Map<string, FmvRow>();
  if (internalIds.length) {
    const { data: fmvRows } = await supabase
      .from("fmv_snapshots")
      .select("edition_id, fmv_usd, confidence, computed_at, source")
      .in("edition_id", internalIds)
      .order("computed_at", { ascending: false });

    for (const row of (fmvRows ?? []) as FmvRow[]) {
      if (!fmvMap.has(row.edition_id)) fmvMap.set(row.edition_id, row);
    }
  }

  // 3. Fetch badges for all players in this set
  const playerNames = [...new Set(
    (editionRows ?? []).map((r: EditionRow) => r.player_name).filter(Boolean) as string[]
  )];
  const badgePremiumMap = new Map<string, number>(); // playerName:seriesNumber → total premium

  if (playerNames.length) {
    const { data: badgeRows } = await supabase
      .from("badge_editions")
      .select("player_name, badge_type, series_number")
      .in("player_name", playerNames);

    for (const row of (badgeRows ?? []) as BadgeRow[]) {
      const key = `${row.player_name}:${row.series_number}`;
      const current = badgePremiumMap.get(key) ?? 0;
      badgePremiumMap.set(key, current + (BADGE_PREMIUMS[row.badge_type] ?? 0));
    }
  }

  // 4. Build results
  return editionKeys.map(externalId => {
    const edition = editionMap.get(externalId);
    if (!edition) {
      return {
        edition: externalId,
        playerName: null, setName: null, seriesName: null, tier: null, circulationCount: null,
        fmv: 0, serialMult: null, badgePremiumPct: 0, adjustedFmv: 0,
        confidence: "unknown", updatedAt: null, source: "none",
        error: "Edition not found",
      };
    }

    const fmv = fmvMap.get(edition.id);
    if (!fmv) {
      return {
        edition: externalId,
        playerName: edition.player_name, setName: edition.set_name,
        seriesName: edition.series_number != null ? (SERIES_NAMES[edition.series_number] ?? `S${edition.series_number}`) : null,
        tier: edition.tier, circulationCount: edition.circulation_count,
        fmv: 0, serialMult: null, badgePremiumPct: 0, adjustedFmv: 0,
        confidence: "unknown", updatedAt: null, source: "none",
        error: "No FMV data available yet",
      };
    }

    const seriesKey = `${edition.player_name}:${edition.series_number}`;
    const totalBadgePremium = badgePremiumMap.get(seriesKey) ?? 0;
    const badgePremiumPct = Math.round(totalBadgePremium * 100);

    const circ = edition.circulation_count ?? 1000;
    const mult = serial != null ? serialMultiplier(serial, circ) : null;
    const adjustedFmv = mult != null
      ? fmv.fmv_usd * mult * (1 + totalBadgePremium)
      : fmv.fmv_usd * (1 + totalBadgePremium);

    return {
      edition: externalId,
      playerName: edition.player_name,
      setName: edition.set_name,
      seriesName: edition.series_number != null ? (SERIES_NAMES[edition.series_number] ?? `S${edition.series_number}`) : null,
      tier: edition.tier,
      circulationCount: circ,
      fmv: round2(fmv.fmv_usd),
      serialMult: mult != null ? round2(mult) : null,
      badgePremiumPct,
      adjustedFmv: round2(adjustedFmv),
      confidence: (fmv.confidence ?? "low").toLowerCase(),
      updatedAt: fmv.computed_at,
      source: fmv.source ?? "rpc",
    };
  });
}

// ─── GET — single edition ─────────────────────────────────────────────────────

export async function GET(req: Request) {
  const url = new URL(req.url);
  const edition = url.searchParams.get("edition");
  const serialParam = url.searchParams.get("serial");
  const serial = serialParam ? parseInt(serialParam, 10) : undefined;

  if (!edition) {
    return NextResponse.json(
      {
        error: "Missing required parameter: edition",
        usage: {
          single: "GET /api/fmv?edition={setID:playID}[&serial=42]",
          batch: "POST /api/fmv { editions: ['setID:playID', ...], serial?: 42 }",
          demo: "GET /api/fmv/demo",
          docs: "https://rip-packs-city.vercel.app/api/fmv/demo",
        },
      },
      { status: 400 }
    );
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  try {
    const results = await lookupEditions(supabase, [edition], serial);
    const result = results[0];

    if (result.error) {
      return NextResponse.json(result, {
        status: result.error === "Edition not found" ? 404 : 200,
        headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=60" },
      });
    }

    return NextResponse.json(result, {
      headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// ─── POST — batch editions ─────────────────────────────────────────────────────

export async function POST(req: Request) {
  let body: { editions?: string[]; serial?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { editions, serial } = body;

  if (!editions || !Array.isArray(editions) || editions.length === 0) {
    return NextResponse.json({ error: "Body must contain non-empty editions array" }, { status: 400 });
  }
  if (editions.length > 100) {
    return NextResponse.json({ error: "Maximum 100 editions per batch request" }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

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