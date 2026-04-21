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

  // If no explicit editionKey filter, scope by collection via an editions join.
  let query = supabase
    .from("sales")
    .select("serial_number, price_usd, sold_at, marketplace, nft_id, edition_id, editions!inner(collection_id, external_id)")
    .order("sold_at", { ascending: false })
    .limit(limit);

  if (editionIdFilter) {
    query = query.eq("edition_id", editionIdFilter);
  } else if (collectionUuid) {
    query = query.eq("editions.collection_id", collectionUuid);
  }

  const { data, error } = await query;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const sales = (data ?? []).map((row: any) => ({
    serialNumber: row.serial_number,
    price: row.price_usd,
    soldAt: row.sold_at,
    marketplace: row.marketplace,
    nftId: row.nft_id,
    editionKey: row.editions?.external_id ?? null,
    playerName: null,
    setName: null,
    fmv: null,
  }));

  return NextResponse.json(
    { sales, collectionId },
    { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=30" } }
  );
}
