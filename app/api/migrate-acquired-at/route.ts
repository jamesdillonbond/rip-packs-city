import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { data, error } = await supabaseAdmin.rpc("exec_sql", {
      query: `
        WITH updated AS (
          UPDATE wallet_moments_cache wmc
          SET acquired_at = ma.acquired_at
          FROM moment_acquisitions ma
          WHERE wmc.moment_id = ma.flow_id
            AND wmc.acquired_at IS NULL
          RETURNING wmc.moment_id
        )
        SELECT count(*) AS updated_count FROM updated;
      `,
    });

    if (error) {
      // Fallback: run the UPDATE directly and count via separate query
      const { error: updateError } = await supabaseAdmin
        .from("wallet_moments_cache")
        .update({ acquired_at: supabaseAdmin.raw("ma.acquired_at") });

      // Use direct SQL instead
      const updateResult = await supabaseAdmin.rpc("execute_sql", {
        sql: `
          UPDATE wallet_moments_cache wmc
          SET acquired_at = ma.acquired_at
          FROM moment_acquisitions ma
          WHERE wmc.moment_id = ma.flow_id
            AND wmc.acquired_at IS NULL;
        `,
      });

      if (updateResult.error) {
        return NextResponse.json(
          { error: updateResult.error.message },
          { status: 500 }
        );
      }

      return NextResponse.json({
        status: "ok",
        message: "Migration executed via execute_sql RPC.",
      });
    }

    return NextResponse.json({
      status: "ok",
      updatedCount: data?.[0]?.updated_count ?? data,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
