import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { syncPinnacleEditions, syncPinnacleListings } from "@/lib/pinnacle/sync";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any;

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const errors: string[] = [];

  try {
    const editionResult = await syncPinnacleEditions(supabaseAdmin);
    errors.push(...editionResult.errors);

    const listingResult = await syncPinnacleListings(supabaseAdmin);
    errors.push(...listingResult.errors);

    // Refresh FMV snapshots from the latest listings + sales. Matches the
    // inline behaviour of /api/pinnacle-listing-cache so the daily cron
    // keeps fmv_snapshots current without a separate trigger.
    const fmvFromListings = await supabaseAdmin.rpc("pinnacle_fmv_from_listings");
    if (fmvFromListings.error) errors.push(`pinnacle_fmv_from_listings: ${fmvFromListings.error.message}`);
    const fmvFromSales = await supabaseAdmin.rpc("pinnacle_fmv_recalc_all");
    if (fmvFromSales.error) errors.push(`pinnacle_fmv_recalc_all: ${fmvFromSales.error.message}`);

    return NextResponse.json({
      status: "ok",
      editions_upserted: editionResult.editions_upserted,
      listings_upserted: listingResult.listings_upserted,
      fmv_from_listings: fmvFromListings.data ?? 0,
      fmv_from_sales: fmvFromSales.data ?? 0,
      errors,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    errors.push(message);
    return NextResponse.json(
      { status: "error", editions_upserted: 0, listings_upserted: 0, errors },
      { status: 500 }
    );
  }
}
