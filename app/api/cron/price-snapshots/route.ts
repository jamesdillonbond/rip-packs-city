import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any;

export const dynamic = "force-dynamic";
export const maxDuration = 15;

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
      .from("price_snapshots_2026")
      .select("bucket", { count: "exact", head: false })
      .order("bucket", { ascending: false })
      .limit(1)
      .single();

    const { count } = await supabaseAdmin
      .from("price_snapshots_2026")
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
