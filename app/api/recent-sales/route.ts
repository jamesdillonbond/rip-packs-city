// app/api/recent-sales/route.ts
//
// Recent sales feed. Phase 2: accepts ?collectionId=<slug> and scopes the
// sales query to that collection via edition_id → editions.collection_id.
// Defaults to nba-top-shot if collectionId is omitted (back-compat for the
// existing /profile page that doesn't yet know about collections).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getCollection, COLLECTION_UUID_BY_SLUG } from "@/lib/collections";
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(req: NextRequest) {
  // Guard against a malformed ?limit (e.g. ?limit=abc): parseInt → NaN →
  // Math.min(NaN,50) → NaN → .limit(NaN) emits `limit=NaN` to PostgREST, which
  // 400s and surfaces as a 500 on this PUBLIC route instead of degrading. Fall
  // back to the default when the value isn't a positive integer.
  const rawLimit = parseInt(req.nextUrl.searchParams.get("limit") ?? "15", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 15;
  const editionKeyParam = req.nextUrl.searchParams.get("editionKey");
  const collectionIdParam = req.nextUrl.searchParams.get("collectionId");
  const collectionId = collectionIdParam ?? "nba-top-shot";
  const collection = getCollection(collectionId);
  const collectionUuid =
    collection?.supabaseCollectionId ?? COLLECTION_UUID_BY_SLUG[collectionId] ?? null;

  // An unrecognised slug must NOT fall through to an unscoped query. Both lookups miss,
  // collectionUuid goes null, the .eq("collection_id", …) below is skipped, and the route
  // would answer 200 with the globally-newest sales — overwhelmingly Top Shot — while
  // echoing the bogus slug back as `collectionId`, so the response looks authoritative.
  // That is a fabricated-data shape. Return empty instead. The OMITTED case still defaults
  // to nba-top-shot (back-compat for /profile), which is why this guards on the raw param.
  if (collectionIdParam && !collectionUuid) {
    return NextResponse.json(
      { sales: [], collectionId },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=30" } }
    );
  }

  // If editionKey is provided, resolve to edition_id first (scoped to collection when possible).
  //
  // 🚨 THE SAME DEFECT THE COMMENT TEN LINES ABOVE DESCRIBES, one parameter over
  // — fixed 2026-09-04. This resolve used to be `const { data: editionRow } =
  // await q.maybeSingle()`, discarding `error` entirely, and then
  // `if (editionRow) editionIdFilter = editionRow.id`. When the lookup failed or
  // missed, `editionIdFilter` stayed null, the `.eq("edition_id", …)` below was
  // SKIPPED, and the route answered **200 with collection-wide (or global)
  // recent sales for a request that asked for ONE edition** — the wrong data
  // presented as the right data, which is worse than the empty list the
  // collection branch above already returns for exactly this reason.
  //
  // The two cases are NOT the same and are no longer conflated:
  //   • the read FAILED  → an honest error; we do not know what this edition sold
  //     for, and must not answer as though we do.
  //   • the read SUCCEEDED and matched nothing → an unknown edition has no sales.
  //     Empty, matching the collection branch's precedent verbatim.
  let editionIdFilter: string | null = null;
  if (editionKeyParam) {
    let q = supabase
      .from("editions")
      .select("id")
      .eq("external_id", editionKeyParam)
      .limit(1);
    if (collectionUuid) q = q.eq("collection_id", collectionUuid);
    const { data: editionRow, error: editionErr } = await boundedRead(
      q.maybeSingle(),
      "api/recent-sales/edition_lookup",
    );
    if (editionErr) return apiErrorResponse(editionErr, "api/recent-sales/edition_lookup");
    if (!editionRow) {
      return NextResponse.json(
        { sales: [], collectionId },
        { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=30" } }
      );
    }
    editionIdFilter = editionRow.id;
  }

  // Scope by collection via sales.collection_id directly (NOT an editions
  // inner-join filter). sales carries an authoritative collection_id column
  // backed by the (collection_id, sold_at DESC) partition index, so this is an
  // instant index range-scan + no sort. The old `editions!inner` +
  // `.eq("editions.collection_id", …)` shape forced a full seq-scan of every
  // sales partition (~1.2M rows) then a top-N sort — ~22s, which surfaced as
  // "Database query failed" on every collection page. editions is now a plain
  // (LEFT) embed used only to hydrate external_id for the ≤50 returned rows.
  let query = supabase
    .from("sales")
    .select("serial_number, price_usd, sold_at, marketplace, nft_id, edition_id, editions(external_id, player_name, set_name)")
    .order("sold_at", { ascending: false })
    .limit(limit);

  if (editionIdFilter) {
    query = query.eq("edition_id", editionIdFilter);
  } else if (collectionUuid) {
    query = query.eq("collection_id", collectionUuid);
  }

  const { data, error } = await query;

  if (error) return apiErrorResponse(error, "api/recent-sales");

  const rows = data ?? [];

  // Batch-hydrate the latest FMV for the returned editions so the panel's
  // "vs FMV" column resolves. player_name / set_name ride along on the editions
  // embed above (denormalized columns, populated for all 4 Flow collections that
  // use the editions table). fmv_current is DISTINCT ON latest-per-edition; the
  // ≤50 returned rows give ≤50 distinct ids, well under the PostgREST cap.
  const editionIds: string[] = Array.from(
    new Set(rows.map((r: any) => r.edition_id).filter((id: any): id is string => !!id))
  );
  const fmvByEdition = new Map<string, number>();
  if (editionIds.length > 0) {
    const { data: fmvRows } = await boundedRead(supabase
      .from("fmv_current")
      .select("edition_id, fmv_usd")
      .in("edition_id", editionIds), "api/recent-sales/fmv_current");
    for (const f of fmvRows ?? []) {
      const v = Number(f.fmv_usd);
      if (f.edition_id && Number.isFinite(v)) fmvByEdition.set(f.edition_id, v);
    }
  }

  const sales = rows.map((row: any) => ({
    serialNumber: row.serial_number,
    price: row.price_usd,
    soldAt: row.sold_at,
    marketplace: row.marketplace,
    nftId: row.nft_id,
    editionKey: row.editions?.external_id ?? null,
    playerName: row.editions?.player_name ?? null,
    setName: row.editions?.set_name ?? null,
    fmv: fmvByEdition.get(row.edition_id) ?? null,
  }));

  return NextResponse.json(
    { sales, collectionId },
    { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=30" } }
  );
}
