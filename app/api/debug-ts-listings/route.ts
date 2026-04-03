import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  const urlSet = !!process.env.NEXT_PUBLIC_SUPABASE_URL;
  const keySet = !!process.env.SUPABASE_SERVICE_ROLE_KEY;
  const keyPrefix = process.env.SUPABASE_SERVICE_ROLE_KEY?.slice(0, 10) ?? "UNSET";

  const { data, error, status, statusText } = await (supabaseAdmin as any)
    .from("ts_listings")
    .select("listing_id, flow_id, player_name, price_usd")
    .limit(3);

  return NextResponse.json({
    urlSet,
    keySet,
    keyPrefix,
    status,
    statusText,
    error: error?.message ?? null,
    rowCount: data?.length ?? null,
    sample: data?.slice(0, 2) ?? null,
  });
}
