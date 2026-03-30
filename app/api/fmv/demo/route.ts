// app/api/fmv/demo/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SERIES_NAMES: Record<number, string> = {
  0: "Beta", 1: "S1", 2: "S2", 3: "S3",
  4: "S4", 5: "S5", 6: "S6", 7: "S7", 8: "S8",
};

function sm(serial: number, circ: number): number {
  if (serial === 1) return 12.0;
  if (serial <= 10) return 4.5;
  if (serial <= 23) return 2.8;
  if (serial === circ) return 3.0;
  return Math.max(1.0, Math.pow(circ / 2 / serial, 0.4));
}
function r2(n: number) { return Math.round(n * 100) / 100; }

export async function GET() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: any = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: fmvRows, error: fmvErr } = await supabase
    .from("fmv_snapshots")
    .select("edition_id, fmv_usd, confidence, computed_at")
    
    .order("computed_at", { ascending: false })
    .limit(20);

  if (fmvErr) return NextResponse.json({ error: fmvErr.message }, { status: 500 });

  const editionIds = [...new Set((fmvRows ?? []).map((r: { edition_id: string }) => r.edition_id))].slice(0, 20);

  const { data: editionRows } = await supabase
    .from("editions")
    .select("id, external_id, player_name, set_name, series_number, tier, circulation_count")
    .in("id", editionIds);

  const edMap = new Map<string, Record<string, unknown>>();
  for (const ed of (editionRows ?? [])) edMap.set(ed.id as string, ed);

  const seen = new Set<string>();
  const samples: unknown[] = [];

  for (const row of (fmvRows ?? [])) {
    const ed = edMap.get(row.edition_id as string);
    if (!ed?.external_id || seen.has(ed.external_id as string)) continue;
    seen.add(ed.external_id as string);
    const circ = (ed.circulation_count as number) ?? 1000;
    const base = row.fmv_usd as number;
    samples.push({
      edition: ed.external_id,
      playerName: ed.player_name,
      setName: ed.set_name,
      seriesName: ed.series_number != null ? (SERIES_NAMES[ed.series_number as number] ?? `S${ed.series_number}`) : null,
      tier: ed.tier,
      circulationCount: circ,
      fmv: r2(base),
      confidence: ((row.confidence as string) ?? "low").toLowerCase(),
      updatedAt: row.computed_at,
      source: "rpc",
      exampleAdjustments: {
        serial1:   { serial: 1,   serialMult: 12.0,       adjustedFmv: r2(base * 12.0) },
        serial23:  { serial: 23,  serialMult: 2.8,        adjustedFmv: r2(base * 2.8) },
        serial100: { serial: 100, serialMult: r2(sm(100, circ)), adjustedFmv: r2(base * sm(100, circ)) },
      },
    });
    if (samples.length >= 5) break;
  }

  return NextResponse.json({
    description: "RIP PACKS CITY — FMV API Demo",
    note: "Real FMV data from our LiveToken-powered pipeline. All values USD.",
    apiUsage: {
      single: "GET  /api/fmv?edition={setID:playID}[&serial=42]",
      batch:  "POST /api/fmv  { editions: ['...'], serial?: 42 }",
      demo:   "GET  /api/fmv/demo",
    },
    editionKeyFormat: "setUUID:playUUID",
    confidenceLevels: { high: "5+ sales/7d", medium: "2–4 sales/7d", low: "0–1 sales/7d" },
    serialMultipliers: { "1": "12x", "2–10": "4.5x", "11–23": "2.8x", "lastMint": "3x", "other": "max(1, (circ/2/serial)^0.4)" },
    sampleCount: samples.length,
    samples,
  }, { headers: { "Cache-Control": "public, max-age=3600" } });
}