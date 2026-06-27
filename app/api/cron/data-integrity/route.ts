import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any;

export const dynamic = "force-dynamic";
export const maxDuration = 15;

// 2026-06-26 fix — this route consumed the pre-2026 health_check() shape
// (fmv_pipeline.coverage_pct / database.size_mb / database.rls_coverage_pct).
// Those keys no longer exist, so it reported a false "FMV coverage at 0%" and its
// db-size/RLS checks were dead. Repointed to the current shape: FMV coverage is
// derived from per-collection editions/fmv_editions; db_size_mb is top-level
// (reported, not flagged — the old 400/500 MB free-tier threshold is obsolete on
// Pro); the dead RLS-key check is dropped (RLS is asserted by the smoke test via
// check_public_security_invariants()).
//
// NOTE: this job is intentionally gated to manual-dispatch-only in
// .github/workflows/ops-monitor.yml. Before re-enabling it on schedule, recalibrate
// the orphan-edition checks below: editions_no_set ≈ 4,752 and
// editions_no_player ≈ 10,544 are a BASELINE (inert UUID-dupe TS editions +
// multi-collection rows that legitimately carry no player/set link), not real
// integrity bugs — left as-is here so a daily schedule isn't turned on against a
// noisy threshold.
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

    // FMV coverage — derived from the current health_check() shape (per-collection
    // editions vs fmv_editions). The old fmv_pipeline.coverage_pct key is gone.
    const { data: hc } = await supabaseAdmin.rpc("health_check");
    const cols = Object.values(hc?.collections ?? {}) as any[];
    const totalEditions = cols.reduce((s, c) => s + (Number(c?.editions) || 0), 0);
    const fmvEditions = cols.reduce((s, c) => s + (Number(c?.fmv_editions) || 0), 0);
    const coveragePct =
      totalEditions > 0 ? Number(((fmvEditions / totalEditions) * 100).toFixed(1)) : null;
    stats.fmv_coverage_pct = coveragePct;
    if (coveragePct != null && coveragePct < 95) {
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

    // db_size_mb is top-level on the current health_check(). Reported for context;
    // NOT flagged — the prior 400/500 MB free-tier threshold is obsolete (Pro tier,
    // DB is multi-GB and tracked by the nightly pass).
    stats.db_size_mb = hc?.db_size_mb ?? null;

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
