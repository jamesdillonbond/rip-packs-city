// app/api/fmv/demo/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

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

  // Fetch recent FMV snapshots (confirmed columns: edition_id, fmv_usd, confidence, computed_at)
  const { data: fmvRows, error: fmvErr } = await supabase
    .from("fmv_snapshots")
    .select("edition_id, fmv_usd, confidence, computed_at")
    .order("computed_at", { ascending: false })
    .limit(20);

  if (fmvErr) return NextResponse.json({ error: fmvErr.message }, { status: 500 });
  if (!fmvRows?.length) return NextResponse.json({ description: "RIP PACKS CITY — FMV API with liquidity rating, outlier-filtered WAP, and daily price history. All values USD.", note: "No FMV data available yet — ingest cron is still populating the database.", sampleCount: 0, samples: [] });

  // Resolve internal IDs → external edition keys (confirmed columns: id, external_id)
  const internalIds = [...new Set(fmvRows.map((r: { edition_id: string }) => r.edition_id))];
  const { data: editionRows } = await supabase
    .from("editions")
    .select("id, external_id")
    .in("id", internalIds);

  const idToExt = new Map<string, string>();
  for (const ed of (editionRows ?? [])) idToExt.set(ed.id as string, ed.external_id as string);

  // Build samples
  const seen = new Set<string>();
  const samples: unknown[] = [];
  const defaultCirc = 1000; // circ unknown at this layer

  for (const row of fmvRows) {
    const externalId = idToExt.get(row.edition_id as string);
    if (!externalId || seen.has(externalId)) continue;
    seen.add(externalId);

    const base = row.fmv_usd as number;
    samples.push({
      edition: externalId,
      fmv: r2(base),
      confidence: ((row.confidence as string) ?? "low").toLowerCase(),
      updatedAt: row.computed_at,
      note: "Serial-adjusted examples use default circ=1000; pass ?serial=N to the single endpoint for precise adjustment",
      exampleAdjustments: {
        serial1:   { serial: 1,   serialMult: 12.0,              adjustedFmv: r2(base * 12.0) },
        serial23:  { serial: 23,  serialMult: 2.8,               adjustedFmv: r2(base * 2.8) },
        serial100: { serial: 100, serialMult: r2(sm(100, defaultCirc)), adjustedFmv: r2(base * sm(100, defaultCirc)) },
      },
    });
    if (samples.length >= 5) break;
  }

  return NextResponse.json({
    description: "RIP PACKS CITY — FMV API with liquidity rating, outlier-filtered WAP, and daily price history. All values USD.",
    note: "Real FMV data from our LiveToken-powered ingest pipeline. All values USD.",
    apiUsage: {
      single: "GET  https://rip-packs-city.vercel.app/api/fmv?edition={setID:playID}[&serial=42]",
      batch:  "POST https://rip-packs-city.vercel.app/api/fmv  { editions: ['...', '...'], serial?: 42 }",
      demo:   "GET  https://rip-packs-city.vercel.app/api/fmv/demo",
    },
    editionKeyFormat: "setUUID:playUUID — from Top Shot's edition system",
    confidenceLevels: { high: "5+ sales/7d", medium: "2–4 sales/7d", low: "0–1 sales/7d" },
    serialMultipliers: { "1": "12x", "2–10": "4.5x", "11–23": "2.8x", lastMint: "3x", other: "max(1, (circ/2/serial)^0.4)" },
    sampleCount: samples.length,
    samples,
  }, { headers: { "Cache-Control": "public, max-age=3600" } });
}