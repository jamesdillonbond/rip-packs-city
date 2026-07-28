// app/api/recent-sales/route.ts
//
// Recent sales feed. Phase 2: accepts ?collectionId=<slug> and scopes the
// sales query to that collection via edition_id → editions.collection_id.
// Defaults to nba-top-shot if collectionId is omitted (back-compat for the
// existing /profile page that doesn't yet know about collections).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getCollection, COLLECTION_UUID_BY_SLUG } from "@/lib/collections";

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(req: NextRequest) {
  const limit = Math.min(
    parseInt(req.nextUrl.searchParams.get("limit") ?? "15"),
    50
  );
  const editionKeyParam = req.nextUrl.searchParams.get("editionKey");
  const collectionId = req.nextUrl.searchParams.get("collectionId") ?? "nba-top-shot";
  const collection = getCollection(collectionId);
  const collectionUuid =
    collection?.supabaseCollectionId ?? COLLECTION_UUID_BY_SLUG[collectionId] ?? null;

  // If editionKey is provided, resolve to edition_id first (scoped to collection when possible).
  let editionIdFilter: string | null = null;
  if (editionKeyParam) {
    let q = supabase
      .from("editions")
      .select("id")
      .eq("external_id", editionKeyParam)
      .limit(1);
    if (collectionUuid) q = q.eq("collection_id", collectionUuid);
    const { data: editionRow } = await q.maybeSingle();
    if (editionRow) editionIdFilter = editionRow.id;
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

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

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
    const { data: fmvRows } = await supabase
      .from("fmv_current")
      .select("edition_id, fmv_usd")
      .in("edition_id", editionIds);
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
