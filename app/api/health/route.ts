import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
) as any;

export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function GET() {
  try {
    const { data, error } = await supabase.rpc("health_check");

    if (error) {
      return NextResponse.json(
        { status: "error", error: error.message },
        { status: 500 }
      );
    }

    const isHealthy =
      !data.fmv_pipeline.is_stale && data.data_integrity.orphaned_editions_ok;

    return NextResponse.json(
      { ...data, status: isHealthy ? "ok" : "degraded" },
      {
        status: isHealthy ? 200 : 503,
        headers: { "Cache-Control": "no-store, max-age=0" },
      }
    );
  } catch (err: any) {
    return NextResponse.json(
      { status: "error", error: err.message || "Unknown error" },
      { status: 500 }
    );
  }
}
