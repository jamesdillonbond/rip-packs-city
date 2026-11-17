import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET() {
  try {
    // ⚠ BOTH failure paths used to publish `{ movers: [] }` — the swallowed RPC
    // error here, and the bare `catch` below. "Nothing moved in the last 24
    // hours" is a MARKET CLAIM, not an empty list, and this response carries
    // `s-maxage=300` so a single failed read was served to every visitor for
    // five minutes. An empty movers list is a real answer; it just has to be
    // earned by a query that came back empty.
    const { data, error } = await boundedRead(supabase.rpc("get_fmv_movers", {
      lookback_interval: "24 hours",
      min_fmv: 1,
      limit_count: 10,
    }), "api/market-movers/get_fmv_movers");
    if (error) {
      return apiErrorResponse(error, "api/market-movers");
    }

    return NextResponse.json({ movers: data ?? [] }, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
    });
  } catch (err) {
    // Same rule for a THROW: it is a failure, not a quiet market.
    return apiErrorResponse(err, "api/market-movers");
  }
}
