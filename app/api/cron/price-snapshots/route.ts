import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any;

export const dynamic = "force-dynamic";
// Bumped 15 -> 60 on 2026-08-08: populate_price_snapshots_hourly() aggregates a
// 1-hour window of sales_2026 (a sold_at range with no collection filter, which
// can't ride the (collection_id, sold_at) index and scans wide), so under pooler
// saturation it exceeded the 15s cap and 504'd — dropping that hour's OHLC bucket
// (measured 7 of 24 recent hourly buckets missing, feeding gappy FMV charts). The
// RPC only ever writes the PRIOR hour and is idempotent (ON CONFLICT DO NOTHING),
// so a longer budget is risk-free and the write completes server-side even if the
// cron caller disconnects first. Follow-up (logic change, not done): add
// `edition_id IS NOT NULL AND price_usd > 0` to the RPC's WHERE so it can use the
// idx_sales_2026_fmv_recalc_window partial index (also drops junk from OHLC).
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { data, error } = await supabaseAdmin.rpc(
      "populate_price_snapshots_hourly"
    );

    if (error) {
      console.error("[price-snapshots] RPC failed:", error.message);
      return NextResponse.json(
        { status: "error", error: error.message },
        { status: 500 }
      );
    }

    console.log(
      `[price-snapshots] ${data.editions_snapshotted} editions snapshotted for bucket ${data.bucket}`
    );

    return NextResponse.json({ status: "ok", ...data });
  } catch (err: any) {
    console.error("[price-snapshots] Unexpected error:", err.message);
    return NextResponse.json(
      { status: "error", error: err.message },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const { data } = await supabaseAdmin
      .from("price_snapshots")
      .select("bucket", { count: "exact", head: false })
      .order("bucket", { ascending: false })
      .limit(1)
      .single();

    const { count } = await supabaseAdmin
      .from("price_snapshots")
      .select("id", { count: "exact", head: true });

    return NextResponse.json({
      status: "ok",
      total_snapshots: count ?? 0,
      latest_bucket: data?.bucket ?? null,
      staleness_hours: data?.bucket
        ? Math.round(
            (Date.now() - new Date(data.bucket).getTime()) / 3600000
          )
        : null,
    });
  } catch (err: any) {
    return NextResponse.json(
      { status: "error", error: err.message },
      { status: 500 }
    );
  }
}
