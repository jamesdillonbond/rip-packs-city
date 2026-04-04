import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET() {
  try {
    const { data } = await supabase.rpc("get_fmv_movers", {
      lookback_interval: "24 hours",
      min_fmv: 1,
      limit_count: 10,
    });

    return NextResponse.json({ movers: data ?? [] }, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
    });
  } catch {
    return NextResponse.json({ movers: [] });
  }
}
