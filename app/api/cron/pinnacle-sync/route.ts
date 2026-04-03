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

    return NextResponse.json({
      status: "ok",
      editions_upserted: editionResult.editions_upserted,
      listings_upserted: listingResult.listings_upserted,
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
