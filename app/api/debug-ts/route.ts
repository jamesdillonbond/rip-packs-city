import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  const steps: Record<string, unknown> = {};

  try {
    // Step 1: Query ts_listings
    const { data: tsRows, error: tsErr } = await (supabaseAdmin as any)
      .from("ts_listings")
      .select("flow_id, player_name, set_name, series_number")
      .limit(5);

    steps.tsQuery = { error: tsErr?.message ?? null, count: tsRows?.length ?? 0, sample: tsRows?.[0] };

    if (!tsRows?.length) return NextResponse.json(steps);

    // Step 2: Query editions
    const { data: edRows, error: edErr } = await (supabaseAdmin as any)
      .from("editions")
      .select("external_id, name, series")
      .limit(10000);

    steps.editionsQuery = { error: edErr?.message ?? null, count: edRows?.length ?? 0 };

    if (!edRows?.length) return NextResponse.json(steps);

    // Step 3: Try matching
    const dashChar = "\u2014";
    let matched = 0;
    for (const r of tsRows) {
      if (!r.player_name || !r.set_name) continue;
      const lookupKey = `${r.player_name.toLowerCase()}|${r.set_name.toLowerCase()}|${r.series_number ?? 0}`;
      for (const e of edRows) {
        const idx = e.name.indexOf(` ${dashChar} `);
        if (idx < 0) continue;
        const eName = e.name.slice(0, idx);
        const eSet = e.name.slice(idx + 3);
        const eKey = `${eName.toLowerCase()}|${eSet.toLowerCase()}|${e.series}`;
        if (eKey === lookupKey) { matched++; break; }
      }
    }
    steps.matching = { tsWithNames: tsRows.filter((r: any) => r.player_name && r.set_name).length, matched };

    // Step 4: Check setPlay parsing
    const sampleEdition = edRows.find((e: any) => e.name.includes(` ${dashChar} `));
    if (sampleEdition) {
      const parts = sampleEdition.external_id.split(":");
      steps.setPlayParse = { external_id: sampleEdition.external_id, setID: parts[0], playID: parts[1], truthy: !!(parts[0] && parts[1]) };
    }

  } catch (err) {
    steps.exception = err instanceof Error ? { message: err.message, stack: err.stack } : String(err);
  }

  return NextResponse.json(steps);
}
