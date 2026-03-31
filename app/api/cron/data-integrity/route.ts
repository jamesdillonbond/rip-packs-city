import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any;

export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const issues: string[] = [];
  const stats: Record<string, any> = {};

  try {
    const { data: orphanedSets } = await supabaseAdmin
      .from("editions")
      .select("id, name, external_id", { count: "exact", head: false })
      .is("set_id", null)
      .limit(10);
    stats.editions_no_set = orphanedSets?.length ?? 0;
    if (stats.editions_no_set > 1) {
      issues.push(
        `${stats.editions_no_set} editions missing set_id: ${(orphanedSets || [])
          .slice(0, 3)
          .map((e: any) => e.name)
          .join(", ")}`
      );
    }

    const { count: noPlayerCount } = await supabaseAdmin
      .from("editions")
      .select("id", { count: "exact", head: true })
      .is("player_id", null)
      .not("name", "like", "Unknown%");
    stats.editions_no_player_real = noPlayerCount ?? 0;
    if (stats.editions_no_player_real > 0) {
      issues.push(`${stats.editions_no_player_real} non-Unknown editions missing player_id`);
    }

    const { data: coverageGap } = await supabaseAdmin.rpc("health_check");
    const coveragePct = coverageGap?.fmv_pipeline?.coverage_pct ?? 0;
    stats.fmv_coverage_pct = coveragePct;
    if (coveragePct < 95) {
      issues.push(`FMV coverage at ${coveragePct}% (target: >=95%)`);
    }

    const { data: badgeFreshness } = await supabaseAdmin
      .from("badge_editions")
      .select("updated_at")
      .order("updated_at", { ascending: false })
      .limit(1)
      .single();
    if (badgeFreshness?.updated_at) {
      const badgeAge = Math.round(
        (Date.now() - new Date(badgeFreshness.updated_at).getTime()) / 3600000
      );
      stats.badge_data_age_hours = badgeAge;
      if (badgeAge > 72) {
        issues.push(`Badge data is ${badgeAge}h old (>72h stale threshold)`);
      }
    }

    stats.db_size_mb = coverageGap?.database?.size_mb ?? null;
    if (stats.db_size_mb && stats.db_size_mb > 400) {
      issues.push(`Database size ${stats.db_size_mb} MB approaching 500 MB free-tier limit`);
    }

    stats.rls_coverage_pct = coverageGap?.database?.rls_coverage_pct ?? null;
    if (stats.rls_coverage_pct && stats.rls_coverage_pct < 100) {
      issues.push(`RLS coverage at ${stats.rls_coverage_pct}% — new unprotected table detected`);
    }

    if (issues.length > 0) {
      console.warn(
        `[data-integrity] ${issues.length} issues found:\n` +
          issues.map((i) => `  ⚠️  ${i}`).join("\n")
      );
    } else {
      console.log(
        `[data-integrity] All checks passed. ` +
          `FMV: ${stats.fmv_coverage_pct}%, ` +
          `DB: ${stats.db_size_mb} MB, ` +
          `RLS: ${stats.rls_coverage_pct}%, ` +
          `Badge age: ${stats.badge_data_age_hours ?? "?"}h`
      );
    }

    return NextResponse.json({
      status: issues.length === 0 ? "ok" : "issues_found",
      issue_count: issues.length,
      issues,
      stats,
      checked_at: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[data-integrity] Error:", err.message);
    return NextResponse.json({ status: "error", error: err.message }, { status: 500 });
  }
}
