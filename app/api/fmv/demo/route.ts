// app/api/fmv/demo/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";
import { fmvSerialMultiplier as sm } from "@/lib/fmv/serial-multiplier";

// ⚠ This route used to carry its OWN COPY of the serial multiplier, and the copy
// had DRIFTED from the real one — its ordinary-serial tail was
// `max(1, (circ/2/serial)^0.4)` where `/api/fmv` computes
// `1 + 0.08·max(0, 1 - serial/circ)`. Those are not near each other: for serial
// 100 of a /1000 edition the fork returned 1.90x and the real endpoint returns
// 1.07x, so this demo — the public, no-auth, 1h-cached surface whose ENTIRE
// PURPOSE is to show a developer what the API does — overstated the serial
// premium by 77% and published a formula string to match.
//
// A demo that does not call the real code path is a second implementation, and
// it will drift again. It now imports the shared module (which exists so "the
// pure multiplier can be unit-tested and its constants pinned"), and
// `__tests__/api-fmv-demo-docs-match-implementation.test.ts` derives the
// documented breakpoints FROM that module so the published spec cannot diverge
// from the code again.
function r2(n: number) { return Math.round(n * 100) / 100; }

export async function GET() {
  const startedAt = Date.now();
  console.log(`[fmv/demo] start`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: any = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Fetch recent FMV snapshots (confirmed columns: edition_id, fmv_usd, confidence, computed_at)
  const fmvT0 = Date.now();
  const { data: fmvRows, error: fmvErr } = await boundedRead(supabase
    .from("fmv_snapshots")
    .select("edition_id, fmv_usd, confidence, computed_at")
    .order("computed_at", { ascending: false })
    .limit(20), "api/fmv/demo/fmv_snapshots");
  console.log(`[fmv/demo] fmv_snapshots query elapsedMs=${Date.now() - fmvT0} rows=${fmvRows?.length ?? 0}`);

  if (fmvErr) {
    console.log(`[fmv/demo] error elapsedMs=${Date.now() - startedAt} message=${fmvErr.message}`);
    return apiErrorResponse(fmvErr, "api/fmv/demo");
  }
  if (!fmvRows?.length) {
    console.log(`[fmv/demo] empty elapsedMs=${Date.now() - startedAt}`);
    return NextResponse.json({ description: "RIP PACKS CITY — FMV API with liquidity rating, outlier-filtered average sales price, and daily price history. All values USD.", note: "No FMV data available yet — ingest cron is still populating the database.", sampleCount: 0, samples: [] });
  }

  // Resolve internal IDs → external edition keys (confirmed columns: id, external_id)
  const internalIds = [...new Set(fmvRows.map((r: { edition_id: string }) => r.edition_id))];
  const edT0 = Date.now();
  // ⚠ HONESTY CANON — the `error` here is load-bearing. This read builds the
  // id→external_id map that every sample is keyed on, so if it fails silently
  // `idToExt` is empty, the loop below `continue`s past every row, and the
  // route answers `sampleCount: 0, samples: []` alongside the note "Real FMV
  // data from our LiveToken-powered ingest pipeline" — at HTTP 200, cached for
  // an HOUR, on the surface whose entire purpose is to show a developer what
  // the API does. The read above already reports its failure honestly; this
  // one has to as well.
  const { data: editionRows, error: edErr } = await boundedRead(supabase
    .from("editions")
    .select("id, external_id")
    .in("id", internalIds), "api/fmv/demo/editions");
  console.log(`[fmv/demo] editions query elapsedMs=${Date.now() - edT0} rows=${editionRows?.length ?? 0}`);

  if (edErr) {
    console.log(`[fmv/demo] editions error elapsedMs=${Date.now() - startedAt} message=${edErr.message}`);
    return apiErrorResponse(edErr, "api/fmv/demo");
  }

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
        serial1:   { serial: 1,   serialMult: r2(sm(1, defaultCirc)),   adjustedFmv: r2(base * sm(1, defaultCirc)) },
        serial23:  { serial: 23,  serialMult: r2(sm(23, defaultCirc)),  adjustedFmv: r2(base * sm(23, defaultCirc)) },
        serial100: { serial: 100, serialMult: r2(sm(100, defaultCirc)), adjustedFmv: r2(base * sm(100, defaultCirc)) },
      },
    });
    if (samples.length >= 5) break;
  }

  console.log(`[fmv/demo] done elapsedMs=${Date.now() - startedAt} samples=${samples.length}`);
  return NextResponse.json({
    description: "RIP PACKS CITY — FMV API with liquidity rating, outlier-filtered average sales price, and daily price history. All values USD.",
    note: "Real FMV data from our LiveToken-powered ingest pipeline. All values USD.",
    apiUsage: {
      single: "GET  https://www.rippackscity.com/api/fmv?edition={setID:playID}[&serial=42]",
      batch:  "POST https://www.rippackscity.com/api/fmv  { editions: ['...', '...'], serial?: 42 }",
      demo:   "GET  https://www.rippackscity.com/api/fmv/demo",
    },
    editionKeyFormat: "setUUID:playUUID — from Top Shot's edition system",
    confidenceLevels: { high: "5+ sales/7d", medium: "2–4 sales/7d", low: "0–1 sales/7d" },
    // Derived from lib/fmv/serial-multiplier so this published spec cannot
    // drift from the code again (circ=2000 is a probe value picked only so the
    // banded branches, not the `serial === circ` one, decide each entry).
    serialMultipliers: {
      "1": `${sm(1, 2000)}x`,
      "2–10": `${sm(10, 2000)}x`,
      "11–23": `${sm(23, 2000)}x`,
      lastMint: `${sm(2000, 2000)}x (applies only when serial === circulation)`,
      other: "1 + 0.08 * max(0, 1 - serial/circ)",
      note: "The single endpoint currently evaluates the curve at a default circ=1000 because it does not read circulation; the banded entries above (serial 1, <=10, <=23) are unaffected by that, the others are approximate.",
    },
    sampleCount: samples.length,
    samples,
  }, { headers: { "Cache-Control": "public, max-age=3600" } });
}