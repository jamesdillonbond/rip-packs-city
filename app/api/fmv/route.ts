// app/api/fmv/route.ts
// Public FMV API - single and batch edition lookup
// GET  /api/fmv?edition={setID:playID}[&serial=42]
// POST /api/fmv  { editions: ['key1', { edition: 'key2', serial: 7 }], serial?: 42 }
// Returns: { count, successCount, errorCount, results[] }

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
// Per-serial weighting lives in a tested lib module (constants pinned there).
import { fmvSerialMultiplier as serialMultiplier } from "@/lib/fmv/serial-multiplier";
import { apiErrorResponse } from "@/lib/api-error";

const SERIES_NAMES: Record<number, string> = {
  0: "S1", 2: "S2", 3: "Sum 21",
  4: "S3", 5: "S4", 6: "23-24", 7: "24-25", 8: "25-26",
};

// Badge premiums are market-priced and excluded from FMV by design.

function r2(n: number) { return Math.round(n * 100) / 100; }

type FmvSnapshotRow = {
  edition_id: string;
  fmv_usd: number;
  confidence: string;
  computed_at: string;
  liquidity_rating: number | null;
  wap_without_outliers: number | null;
  sales_count_30d: number | null;
  days_since_sale: number | null;
  wap_usd: number | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function lookupEditions(supabase: any, editionKeys: string[], serial?: number) {
  if (!editionKeys.length) return { results: [], extToId: new Map<string, string>() };

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

  // Step 2: fetch FMV — from fmv_current (DISTINCT ON latest-per-edition),
  // NOT raw fmv_snapshots.
  //
  // ⚠ deep-audit R3. The previous shape was the D27 anti-pattern this repo has
  // already fixed twice elsewhere (app/api/alerts/route.ts, allday-pack-ev):
  // select raw fmv_snapshots ordered by computed_at DESC and dedupe first-wins
  // in JS. fmv_snapshots keeps daily history — measured 40.7 rows per Top Shot
  // edition, max 209 — and PostgREST caps ANY read at 1000 rows, including an
  // unbounded one. On a realistic 100-edition batch the query yields ~3,702
  // rows, so the window covered 50 of 100 and the other 50 were reported as
  // `"No FMV data yet"` — a false claim about our own coverage, manufactured
  // from a row cap, on the DOCUMENTED PRODUCT API (and the public /api/fmv/demo).
  //
  // One row per edition means the chunking below bounds the IN-list, not the
  // result set. The JS first-wins dedup is kept and is now a harmless no-op.
  //
  // ⚠ Column note: fmv_current exposes `wap_usd` directly and has NO `asp_usd`,
  // so the old `wap_usd:asp_usd` alias must NOT be carried over — it would 400.
  const fmvMap = new Map<string, FmvSnapshotRow>();
  const FMV_CHUNK = 500;
  for (let i = 0; i < internalIds.length; i += FMV_CHUNK) {
    const chunk = internalIds.slice(i, i + FMV_CHUNK);
    // ⚠ HONESTY CANON — this `error` is load-bearing, do not drop it again.
    // supabase-js RETURNS errors rather than throwing, so a swallowed `error`
    // leaves `fmvRows` null and every edition in the chunk falls through to the
    // `if (!fmv)` branch below, which publishes `fmv: 0` and
    // `error: "No FMV data yet"` at HTTP 200 under `max-age=300`. That is the
    // exact false claim about our own coverage the comment above documents —
    // manufactured from a FAILED READ instead of a row cap, on the documented
    // public product API, and then cached for five minutes. Step 1 already
    // throws on `edErr`; step 2 must too, so a read failure reaches
    // `apiErrorResponse` and is reported as a failure rather than as an answer.
    const { data: fmvRows, error: fmvErr } = await supabase
      .from("fmv_current")
      .select("edition_id, fmv_usd, confidence, computed_at, liquidity_rating, wap_without_outliers:asp_without_outliers, sales_count_30d, days_since_sale, wap_usd")
      .in("edition_id", chunk);

    if (fmvErr) throw new Error(`fmv_current lookup: ${fmvErr.message}`);

    for (const row of (fmvRows ?? []) as FmvSnapshotRow[]) {
      if (!fmvMap.has(row.edition_id)) fmvMap.set(row.edition_id, row);
    }
  }

  // Badge premiums are market-priced and excluded from FMV by design.

  const results = editionKeys.map(externalId => {
    const internalId = extToId.get(externalId);

    if (!internalId) {
      return { edition: externalId, fmv: 0, serialMult: null, adjustedFmv: 0, confidence: "unknown", updatedAt: null, fallbackTier: "none", liquidityRating: null, aspUsd: null, aspClean: null, salesCount30d: null, daysSinceSale: null, error: "Edition not found" };
    }

    const fmv = fmvMap.get(internalId);
    if (!fmv) {
      return { edition: externalId, fmv: 0, serialMult: null, adjustedFmv: 0, confidence: "unknown", updatedAt: null, fallbackTier: "none", liquidityRating: null, aspUsd: null, aspClean: null, salesCount30d: null, daysSinceSale: null, error: "No FMV data yet" };
    }

    const baseFmv = fmv.fmv_usd;
    const mult = serial != null ? serialMultiplier(serial, 1000) : null; // circ unknown without metadata
    const adjustedFmv = mult != null ? baseFmv * mult : baseFmv;
    const confidence = (fmv.confidence ?? "low").toLowerCase();

    // Which fallback tier produced this value. Only "rpc_fmv" (the primary
    // snapshot) is implemented; the not-found paths above report "none".
    // A guarded `if (fallbackTier !== "rpc_fmv")` log used to sit here — with
    // fallbackTier a const bound to the literal, TS narrows it and the branch
    // was provably unreachable. Restore real logging alongside a real tier.
    const fallbackTier = "rpc_fmv";

    return {
      edition: externalId,
      fmv: r2(baseFmv),
      serialMult: mult != null ? r2(mult) : null,
      adjustedFmv: r2(adjustedFmv),
      confidence,
      updatedAt: fmv.computed_at,
      fallbackTier,
      liquidityRating: fmv.liquidity_rating ?? null,
      aspUsd: fmv.wap_usd ? r2(fmv.wap_usd) : null,
      aspClean: fmv.wap_without_outliers ? r2(fmv.wap_without_outliers) : null,
      salesCount30d: fmv.sales_count_30d ?? null,
      daysSinceSale: fmv.days_since_sale ?? null,
    };
  });

  return { results, extToId };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const edition = url.searchParams.get("edition");
  const serialParam = url.searchParams.get("serial");
  const serial = serialParam ? parseInt(serialParam, 10) : undefined;
  const includeHistory = url.searchParams.get("history") === "true";

  if (!edition) {
    return NextResponse.json({
      error: "Missing required parameter: edition",
      usage: {
        single: "GET /api/fmv?edition={setID:playID}[&serial=42][&history=true]",
        batch:  "POST /api/fmv  { editions: ['key1', { edition: 'key2', serial: 7 }], serial?: 42 }",
        demo:   "GET /api/fmv/demo",
        notes:  "Batch accepts up to 100 editions. Each can be a string or { edition, serial? }. Global serial applies to entries without per-edition serial. history=true returns the last 21 daily FMV values for a single edition.",
      },
    }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: any = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  try {
    const editionKeys = [edition];
    const { results, extToId } = await lookupEditions(supabase, editionKeys, serial);

    if (includeHistory && editionKeys.length === 1) {
      const internalId = extToId.get(editionKeys[0]);
      if (internalId) {
        const { data: historyRows, error: historyErr } = await supabase
          .from("fmv_snapshots")
          .select("fmv_usd, computed_at, sales_count_30d")
          .eq("edition_id", internalId)
          .order("computed_at", { ascending: false })
          .limit(21);
        // A failed history read must not render as "this edition has no price
        // history". Unlike the FMV read above it is NOT fatal — the FMV value
        // itself is already resolved and correct — so the honest shape is the
        // third state: say the series could not be read, rather than omitting
        // `priceHistory` (which is indistinguishable from a genuinely empty
        // series) or emitting an empty array (which claims one).
        if (historyErr) {
          console.log(`[api/fmv] priceHistory read failed for ${editionKeys[0]}: ${historyErr.message}`);
          if (results.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (results[0] as any).priceHistoryUnavailable = true;
          }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (!historyErr && historyRows && historyRows.length > 0) {
          const priceHistory = historyRows.reverse().map((row: any) => ({
            date: typeof row.computed_at === "string" ? row.computed_at.slice(0, 10) : null,
            fmv: r2(row.fmv_usd),
            samples: row.sales_count_30d ?? null,
          }));
          if (results.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (results[0] as any).priceHistory = priceHistory;
          }
        }
      }
    }

    const result = results[0];
    const status = result?.error === "Edition not found" ? 404 : 200;
    return NextResponse.json(result, {
      status,
      headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    return apiErrorResponse(err, "api/fmv", "FMV lookup isn't available right now.");
  }
}

export async function POST(req: Request) {
  let body: { editions?: (string | { edition: string; serial?: number })[]; serial?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const { editions, serial: globalSerial } = body;
  if (!editions || !Array.isArray(editions) || editions.length === 0)
    return NextResponse.json({ error: "Body must contain non-empty editions array" }, { status: 400 });
  if (editions.length > 100)
    return NextResponse.json({ error: "Maximum 100 editions per batch request" }, { status: 400 });

  // Normalize input: accept plain strings or { edition, serial? } objects
  const editionKeys: string[] = [];
  const serialOverrides = new Map<string, number>();
  for (const entry of editions) {
    if (typeof entry === "string") {
      editionKeys.push(entry);
    } else if (entry && typeof entry === "object" && typeof entry.edition === "string") {
      editionKeys.push(entry.edition);
      if (typeof entry.serial === "number") serialOverrides.set(entry.edition, entry.serial);
    } else {
      return NextResponse.json({ error: "Each edition must be a string or { edition: string, serial?: number }" }, { status: 400 });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: any = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  try {
    // Resolve editions -> internal IDs first; FMV snapshots are then fetched in
    // chunks keyed on those IDs (see below). This was a two-element Promise.all
    // whose second element was a dead `Promise.resolve(null)` placeholder — the
    // FMV lookup genuinely can't start until the IDs resolve, so there was
    // nothing to parallelize.
    const editionRes = await supabase.from("editions").select("id, external_id").in("external_id", editionKeys);

    if (editionRes.error) throw new Error(`editions lookup: ${editionRes.error.message}`);

    const extToId = new Map<string, string>();
    for (const row of (editionRes.data ?? [])) {
      extToId.set(row.external_id, row.id);
    }

    const internalIds = Array.from(extToId.values());

    // Fetch FMV snapshots in parallel chunks for large batches
    const fmvMap = new Map<string, FmvSnapshotRow>();
    if (internalIds.length) {
      const CHUNK = 50;
      const fmvChunks = [];
      for (let i = 0; i < internalIds.length; i += CHUNK) {
        fmvChunks.push(
          // fmv_current = DISTINCT-ON latest-per-edition (1 row/edition), so cold
          // editions in a mixed batch aren't dropped past the 1000-row cap and
          // wrongly reported "No FMV data yet". (asp_usd is exposed as wap_usd.)
          supabase
            .from("fmv_current")
            .select("edition_id, fmv_usd, confidence, computed_at, liquidity_rating, wap_without_outliers:asp_without_outliers, sales_count_30d, days_since_sale, wap_usd")
            .in("edition_id", internalIds.slice(i, i + CHUNK))
        );
      }
      const fmvResults = await Promise.all(fmvChunks);
      // ⚠ HONESTY CANON, and the batch path is the WORSE half of it. A chunk is
      // 50 editions of up to 100, so one failed chunk does not fail the request
      // — it silently reports `fmv: 0` / "No FMV data yet" for those editions,
      // counts them into `errorCount` as if they had no data, and serves the
      // mix at HTTP 200 under `max-age=300`. A caller cannot distinguish the
      // half we could not read from the half that is genuinely uncovered.
      // `Promise.all` does not help here: supabase-js RESOLVES on a query
      // error, so every chunk "succeeds" and the error rides in `.error`.
      for (const { data: fmvRows, error: fmvErr } of fmvResults) {
        if (fmvErr) throw new Error(`fmv_current lookup: ${fmvErr.message}`);
        for (const row of (fmvRows ?? []) as FmvSnapshotRow[]) {
          if (!fmvMap.has(row.edition_id)) fmvMap.set(row.edition_id, row);
        }
      }
    }

    // Build results with per-edition serial support
    let successCount = 0;
    let errorCount = 0;
    const results = editionKeys.map(externalId => {
      const internalId = extToId.get(externalId);
      if (!internalId) {
        errorCount++;
        return { edition: externalId, fmv: 0, serialMult: null, adjustedFmv: 0, confidence: "unknown", updatedAt: null, fallbackTier: "none", liquidityRating: null, aspUsd: null, aspClean: null, salesCount30d: null, daysSinceSale: null, error: "Edition not found" };
      }

      const fmv = fmvMap.get(internalId);
      if (!fmv) {
        errorCount++;
        return { edition: externalId, fmv: 0, serialMult: null, adjustedFmv: 0, confidence: "unknown", updatedAt: null, fallbackTier: "none", liquidityRating: null, aspUsd: null, aspClean: null, salesCount30d: null, daysSinceSale: null, error: "No FMV data yet" };
      }

      const baseFmv = fmv.fmv_usd;
      const serial = serialOverrides.get(externalId) ?? globalSerial;
      const mult = serial != null ? serialMultiplier(serial, 1000) : null;
      const adjustedFmv = mult != null ? baseFmv * mult : baseFmv;
      const confidence = (fmv.confidence ?? "low").toLowerCase();

      // Which fallback tier produced this value. Only "rpc_fmv" (the primary
      // snapshot) is implemented; the not-found paths above report "none".
      // A guarded `if (fallbackTier !== "rpc_fmv")` log used to sit here — with
      // fallbackTier a const bound to the literal, TS narrows it and the branch
      // was provably unreachable. Restore real logging alongside a real tier.
      const fallbackTier = "rpc_fmv";

      successCount++;
      return {
        edition: externalId,
        fmv: r2(baseFmv),
        serialMult: mult != null ? r2(mult) : null,
        adjustedFmv: r2(adjustedFmv),
        confidence,
        updatedAt: fmv.computed_at,
        fallbackTier,
        liquidityRating: fmv.liquidity_rating ?? null,
        aspUsd: fmv.wap_usd ? r2(fmv.wap_usd) : null,
        aspClean: fmv.wap_without_outliers ? r2(fmv.wap_without_outliers) : null,
        salesCount30d: fmv.sales_count_30d ?? null,
        daysSinceSale: fmv.days_since_sale ?? null,
      };
    });

    return NextResponse.json(
      { count: results.length, successCount, errorCount, results },
      { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=60" } }
    );
  } catch (err) {
    return apiErrorResponse(err, "api/fmv", "FMV lookup isn't available right now.");
  }
}