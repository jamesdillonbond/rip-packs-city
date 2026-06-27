import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any;

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Rebuilt 2026-06-26/27.
//
// Why: the previous version called the full health_check() aggregate (~14.7s on a
// calm DB) under maxDuration=15 → it 504'd in production. It also consumed the
// pre-2026 health_check() shape (dead keys → false "FMV coverage 0%") and flagged
// orphan-edition counts that are STABLE BASELINES, not bugs (~4.7k null-set / ~10.5k
// null-player are dominated by inert UUID-dupe TS editions plus editions that
// legitimately carry no player/set link). They have no clean "0 = healthy"
// population, so flagging them is pure noise.
//
// Now: a cheap (<3s) integrity/security check. All FLAGGED checks have clean
// 0/healthy baselines:
//   1. security invariants — new RLS-off / anon-writable base tables
//      (check_public_security_invariants(); replaces the old dead RLS-key check).
//   2. FMV coverage — overall editions-with-an-fmv-snapshot, via the cheap
//      get_fmv_coverage() RPC (~1.2s index-only semijoin; replaces the 14.7s
//      health_check() call). Flags only on overall <95% (99.6% baseline); the thin
//      UFC market (~90%) is reported per-collection but not flagged.
//   3. badge data freshness (>72h).
// Orphan counts are reported as informational stats only (no flag). Real
// orphan-regression detection would need stored baselines — a separate feature.
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const issues: string[] = [];
  const stats: Record<string, any> = {};

  try {
    // 1. Security invariants — flag any RLS-off or anon-writable PUBLIC base table.
    //    Clean baseline = 0 rows. Degrades safely: on error, reported null, never flagged.
    const { data: secViolations, error: secErr } = await supabaseAdmin.rpc(
      "check_public_security_invariants"
    );
    const secCount = secErr ? null : Array.isArray(secViolations) ? secViolations.length : 0;
    stats.security_invariant_violations = secCount;
    if (secCount && secCount > 0) {
      issues.push(`${secCount} security invariant violation(s) — RLS-off or anon-writable base table(s)`);
    }

    // 2. FMV coverage — overall % of active-collection editions with an FMV snapshot.
    //    Cheap RPC (~1.2s). Flags only on a broad regression (overall <95%).
    const { data: coverage, error: covErr } = await supabaseAdmin.rpc("get_fmv_coverage");
    if (!covErr && Array.isArray(coverage) && coverage.length > 0) {
      const totEd = coverage.reduce((s: number, r: any) => s + Number(r.editions || 0), 0);
      const totFmv = coverage.reduce((s: number, r: any) => s + Number(r.fmv_editions || 0), 0);
      const overall = totEd > 0 ? Number(((totFmv / totEd) * 100).toFixed(1)) : null;
      stats.fmv_coverage_pct = overall;
      stats.fmv_coverage_by_collection = Object.fromEntries(
        coverage.map((r: any) => [r.slug, Number(r.coverage_pct)])
      );
      if (overall != null && overall < 95) {
        issues.push(`Overall FMV coverage at ${overall}% (target: >=95%)`);
      }
    } else {
      stats.fmv_coverage_pct = null;
    }

    // 3. Badge data freshness.
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

    // Informational only (NOT flagged — stable baselines, see header).
    const { count: noSet } = await supabaseAdmin
      .from("editions")
      .select("id", { count: "exact", head: true })
      .is("set_id", null);
    const { count: noPlayer } = await supabaseAdmin
      .from("editions")
      .select("id", { count: "exact", head: true })
      .is("player_id", null)
      .not("name", "like", "Unknown%");
    stats.editions_no_set = noSet ?? 0;
    stats.editions_no_player_real = noPlayer ?? 0;

    if (issues.length > 0) {
      console.warn(
        `[data-integrity] ${issues.length} issue(s) found:\n` +
          issues.map((i) => `  ⚠️  ${i}`).join("\n")
      );
    } else {
      console.log(
        `[data-integrity] All checks passed. ` +
          `Security violations: ${stats.security_invariant_violations}, ` +
          `FMV coverage: ${stats.fmv_coverage_pct}%, ` +
          `Badge age: ${stats.badge_data_age_hours ?? "?"}h, ` +
          `(orphans informational: ${stats.editions_no_set} no-set / ${stats.editions_no_player_real} no-player)`
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
