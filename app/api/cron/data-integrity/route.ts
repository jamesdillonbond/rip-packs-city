import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendOpsAlert } from "@/lib/ops-alert";
import { rpcWithRetry, withQueryDeadline } from "@/lib/analytics/rpc-with-retry";

// EVERY DB leg is bounded, and the budgets are chosen so their SUM fits inside
// maxDuration=30: 6 + 8 + 3 + 3 + 3 = 23s worst case, leaving headroom for cold
// start and the response.
//
// ⚠ These exist because UNBOUNDED legs took the whole endpoint down. Measured
// 2026-08-18 during a saturation spell: get_fmv_coverage() did not finish in 55s,
// so the 30s lambda died with FUNCTION_INVOCATION_TIMEOUT and the route returned
// NOTHING — including the security-invariant result, which is the one check here
// that must never go dark.
//
// ⚠ BOUNDING ONLY THE TWO RPCs WAS NOT ENOUGH — verified against production, the
// route still 504'd at exactly 30s with both RPCs capped at 8+10. The three table
// reads were left unbounded on the strength of their SQL being fast (461ms/503ms/
// 9.5ms, measured). That was the wrong inference: those timings came from a direct
// SQL connection, while the route reaches them through PostgREST, where a request
// can sit in an acquire queue for far longer than its statement takes to run. A
// leg is bounded or it is not; "the query is fast" is not a bound.
//
// `timeoutMs` is a TOTAL budget across attempts (shared deadline in
// rpc-with-retry), so it bounds each call regardless of retry settings, and a
// timeout is terminal rather than retried. Genuine throws still propagate.
const SECURITY_RPC_TIMEOUT_MS = 6_000;
const COVERAGE_RPC_TIMEOUT_MS = 8_000;
const TABLE_READ_TIMEOUT_MS = 3_000;

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
//   1. security invariants — 6 arms: RLS-off base tables, anon-writable base
//      tables, updatable+anon-writable views, unexpected-definer views,
//      anon-EXECUTE secdef trigger fns, and anon-readable materialized views
//      (check_public_security_invariants(); replaces the old dead RLS-key check).
//   2. FMV coverage — overall editions-with-an-fmv-snapshot, via the
//      get_fmv_coverage() RPC (replaces the old health_check() call). Flags only
//      on overall <95%; the thin UFC market is reported per-collection but not
//      flagged. ⚠ No latency figure is quoted here ON PURPOSE — see the block at
//      the call site: the last two numbers in this comment were both dated
//      samples that went wrong in opposite directions.
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
    const { data: secViolations, error: secErr } = await rpcWithRetry<any[]>(
      supabaseAdmin,
      "check_public_security_invariants",
      {},
      { timeoutMs: SECURITY_RPC_TIMEOUT_MS }
    );
    const secCount = secErr ? null : Array.isArray(secViolations) ? secViolations.length : 0;
    stats.security_invariant_violations = secCount;
    if (secCount && secCount > 0) {
      // ⚠ REPORT the arms that actually fired, never restate a fixed subset of
      // them. This string used to read "RLS-off or anon-writable base table(s)",
      // which names 2 of the 6 arms — so a view, a secdef trigger fn or an
      // anon-readable materialized view was reported under the wrong cause.
      const kinds = Array.isArray(secViolations)
        ? [...new Set(secViolations.map((v: any) => String(v?.kind ?? "unknown")))].sort().join(", ")
        : "unknown";
      issues.push(`${secCount} security invariant violation(s) — ${kinds}`);
    }

    // 2. FMV coverage — overall % of active-collection editions with an FMV snapshot.
    //    Flags only on a broad regression (overall <95%).
    //
    // ⚠ THIS COMMENT HAS NOW BEEN WRONG TWICE, IN OPPOSITE DIRECTIONS, AND BOTH
    // TIMES BECAUSE A ONE-INSTANT READING WAS WRITTEN DOWN AS A PROPERTY.
    //
    //   1. It claimed "~1.2s index-only semijoin". That was a dated sample quoted
    //      as a constant, and it was not even the right plan shape.
    //   2. The correction claimed "did not finish in 55s" and blamed the double
    //      SubPlan. The 55s was real but it was measured DURING a disk-IO
    //      saturation spell, and the blame was misattributed.
    //
    // Re-measured 2026-08-18 in a QUIET window (3 active sessions, 1 in IO wait,
    // zero autovacuum workers), warm-vs-warm on the same instrument: the OLD
    // double-SubPlan body ran in 1,470 / 1,609 ms at 196,106 buffers. So the plan
    // shape NEVER cost 55s — saturation did. The RPC is now a single lateral probe
    // (migration audit_20260818_get_fmv_coverage_single_probe): 100,014 buffers,
    // 909 ms, values verified identical across all four active collections.
    //
    // ⚠ DO NOT READ THAT AS "the timeout is fixed." It is not the timeout's cause,
    // so it cannot be its fix: under the next saturation spell this RPC can still
    // blow any budget, and `timeoutMs` below is what keeps the clean, instant
    // security-invariant result from going dark with it. The bound is the
    // load-bearing part; the rewrite just stops paying twice for one answer.
    //
    // If you are tempted to put a fresh millisecond figure in this comment: that
    // is exactly what went wrong the last two times. Measure it yourself.
    const { data: coverage, error: covErr } = await rpcWithRetry<any[]>(
      supabaseAdmin,
      "get_fmv_coverage",
      {},
      { timeoutMs: COVERAGE_RPC_TIMEOUT_MS }
    );
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
    const { data: badgeFreshness } = await withQueryDeadline<{ updated_at: string }>(
      supabaseAdmin
        .from("badge_editions")
        .select("updated_at")
        .order("updated_at", { ascending: false })
        .limit(1)
        .single(),
      "badge_editions.latest",
      TABLE_READ_TIMEOUT_MS
    );
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
    // ⚠ null on error, matching this file's own convention for the security
    // invariant above ("on error, reported null, never flagged"). These were
    // `?? 0`, which reports "0 orphans" — a measurement — from a failed count.
    // Unlike the sibling `stale-fmv-monitor`, nothing here is GATED on them, so
    // this was cosmetic rather than a fail-open verdict; the log line directly
    // below already prints `?? "?"` for an unknown badge age, so the honest
    // spelling was already in scope.
    // ⚠ Bounded like every other leg. A timeout arrives as `error`, which the
    // null-on-error spelling below already handles — it reports UNKNOWN, never a
    // measured "0 orphans".
    const { count: noSet, error: noSetErr } = (await withQueryDeadline(
      supabaseAdmin.from("editions").select("id", { count: "exact", head: true }).is("set_id", null),
      "editions.no_set",
      TABLE_READ_TIMEOUT_MS
    )) as { count?: number | null; error: any };
    const { count: noPlayer, error: noPlayerErr } = (await withQueryDeadline(
      supabaseAdmin
        .from("editions")
        .select("id", { count: "exact", head: true })
        .is("player_id", null)
        .not("name", "like", "Unknown%"),
      "editions.no_player",
      TABLE_READ_TIMEOUT_MS
    )) as { count?: number | null; error: any };
    stats.editions_no_set = noSetErr ? null : noSet ?? null;
    stats.editions_no_player_real = noPlayerErr ? null : noPlayer ?? null;

    if (issues.length > 0) {
      console.warn(
        `[data-integrity] ${issues.length} issue(s) found:\n` +
          issues.map((i) => `  ⚠️  ${i}`).join("\n")
      );
      // Push to the ops channels — issue_count>0 previously only emitted a
      // GitHub annotation, so a security-invariant violation / coverage drop
      // could sit unseen. Debounced 12h (daily cron ⇒ pages each red run).
      await sendOpsAlert({
        key: "data-integrity",
        cooldownMinutes: 720,
        subject: `\u{1F6A8} RPC data-integrity: ${issues.length} issue(s)`,
        text:
          `RPC data-integrity found ${issues.length} issue(s):\n` +
          issues.map((i) => `  • ${i}`).join("\n"),
      });
    } else {
      console.log(
        `[data-integrity] All checks passed. ` +
          `Security violations: ${stats.security_invariant_violations}, ` +
          `FMV coverage: ${stats.fmv_coverage_pct}%, ` +
          `Badge age: ${stats.badge_data_age_hours ?? "?"}h, ` +
          `(orphans informational: ${stats.editions_no_set ?? "?"} no-set / ${stats.editions_no_player_real ?? "?"} no-player)`
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
