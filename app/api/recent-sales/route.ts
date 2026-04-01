import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(req: NextRequest) {
  const limit = Math.min(
    parseInt(req.nextUrl.searchParams.get("limit") ?? "15"),
    50
  );

  const { data, error } = await supabase
    .from("sales")
    .select("serial_number, price_usd, sold_at, marketplace, nft_id, edition_id")
    .order("sold_at", { ascending: false })
    .limit(limit);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Pull edition external_ids in one batch query
  const editionIds = [...new Set((data ?? []).map((r: any) => r.edition_id).filter(Boolean))];
  const editionMap = new Map<string, string>();
  if (editionIds.length > 0) {
    const { data: editions } = await supabase
      .from("editions")
      .select("id, external_id")
      .in("id", editionIds);
    for (const e of editions ?? []) editionMap.set(e.id, e.external_id);
  }

  const sales = (data ?? []).map((row: any) => ({
    serialNumber: row.serial_number,
    price: row.price_usd,
    soldAt: row.sold_at,
    marketplace: row.marketplace,
    nftId: row.nft_id,
    editionKey: editionMap.get(row.edition_id) ?? null,
    playerName: null,
    setName: null,
    fmv: null,
  }));

  return NextResponse.json(
    { sales },
    { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=30" } }
  );
}
