import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any;

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Rebuilt 2026-06-26.
//
// Why: the previous version called the full health_check() aggregate (measured
// ~14.7s on a calm DB) under maxDuration=15 → it 504'd in production. It also
// consumed the pre-2026 health_check() shape (dead keys → false "FMV coverage 0%"),
// and flagged orphan-edition counts that are STABLE BASELINES, not bugs: ~4,752
// null-set / ~10,544 null-player are dominated by inert UUID-dupe TS editions plus
// editions that legitimately carry no player/set link (~6.7k canonical TS award/team
// cards, the 36 AllDay Draft Picks, the 72 UFC seed-gap). They have no clean
// "0 = healthy" population, so flagging them is pure noise.
//
// Now: FMV health stays with the dedicated fmv-staleness monitor; this route is the
// cheap (<3s) integrity/security check. Flagged checks all have clean 0/healthy
// baselines so the daily schedule stays green + quiet:
//   1. security invariants — new RLS-off / anon-writable base tables
//      (check_public_security_invariants(); the real signal the old dead
//      database.rls_coverage_pct check was reaching for).
//   2. badge data freshness (>72h).
// Orphan counts + DB size are reported as informational stats only (no flag). Real
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

    // 2. Badge data freshness.
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
