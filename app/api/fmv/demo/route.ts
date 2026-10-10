// app/api/fmv/demo/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";

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
// it will drift again. Since 2026-10-10 (known-issues #18) /api/fmv prices the
// serial premium with the FITTED model (serial_fmv_multiplier_batch ->
// serial_fmv_estimate), so the examples below are computed by the SAME batch call
// for the sample editions -- no constants live here, and
// `__tests__/api-fmv-demo-docs-match-implementation.test.ts` pins that.
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
  const picked: Array<{ id: string; externalId: string; base: number; confidence: string; computedAt: unknown }> = [];
  for (const row of fmvRows) {
    const externalId = idToExt.get(row.edition_id as string);
    if (!externalId || seen.has(externalId)) continue;
    seen.add(externalId);
    picked.push({ id: row.edition_id as string, externalId, base: row.fmv_usd as number,
                  confidence: (row.confidence as string) ?? "LOW", computedAt: row.computed_at });
    if (picked.length >= 5) break;
  }

  // The example serial premiums come from the SAME call /api/fmv makes (the fitted model).
  // A failed read is a failure: the demo must not publish premiums it could not compute.
  const EXAMPLE_SERIALS = [1, 23, 100];
  const { data: multRows, error: multErr } = await supabase.rpc("serial_fmv_multiplier_batch", {
    p_items: picked.flatMap(p => EXAMPLE_SERIALS.map(serial => ({ edition_id: p.id, serial, fmv: p.base, confidence: p.confidence }))),
  });
  if (multErr) {
    console.log(`[fmv/demo] serial multipliers error elapsedMs=${Date.now() - startedAt} message=${multErr.message}`);
    return apiErrorResponse(multErr, "api/fmv/demo");
  }
  const multBy = new Map<string, { multiplier: number | null; basis: string }>();
  for (const r of (Array.isArray(multRows) ? multRows : []) as Array<{ edition_id: string; serial: number; multiplier: number | null; basis: string }>) {
    multBy.set(`${r.edition_id}:${r.serial}`, { multiplier: r.multiplier == null ? null : Number(r.multiplier), basis: r.basis });
  }
  const example = (p: { id: string; base: number }, serial: number) => {
    const m = multBy.get(`${p.id}:${serial}`);
    const mult = m?.multiplier ?? null;
    return { serial, serialMult: mult != null ? r2(mult) : null, serialBasis: m?.basis ?? null,
             adjustedFmv: r2(mult != null ? p.base * mult : p.base) };
  };

  const samples: unknown[] = picked.map(p => ({
    edition: p.externalId,
    fmv: r2(p.base),
    confidence: p.confidence.toLowerCase(),
    updatedAt: p.computedAt,
    note: "Serial-adjusted examples are computed by the same fitted model /api/fmv uses; pass ?serial=N to the single endpoint for any serial",
    exampleAdjustments: {
      serial1: example(p, 1),
      serial23: example(p, 23),
      serial100: example(p, 100),
    },
  }));

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
    // The fitted model, described rather than tabulated: its multiplier depends on the edition's
    // FMV, tier and circulation band, so any fixed table here would misstate it.
    serialMultipliers: {
      model: "fitted per collection x tier x circulation band (serial_fmv_estimate): a power law in the edition's FMV, fitted on sales",
      buckets: "#1 serial, jersey-match serial and perfect (last) mint; any other serial carries no premium (serialMult 1)",
      response: "serialMult = estimate / fmv; serialBasis names the bucket: 'first', 'jersey', 'perfect' or 'no_premium'",
      unknown: "serialMult null with serialBasis 'circulation_unknown' when the edition's catalog circulation is missing or below the serial",
      note: "Cheap editions carry larger multiples than expensive ones for the same serial, because the fitted premium grows slower than FMV.",
    },
    sampleCount: samples.length,
    samples,
  }, { headers: { "Cache-Control": "public, max-age=3600" } });
}