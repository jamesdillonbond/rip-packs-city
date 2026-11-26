import { bearerMatches } from "@/lib/auth/bearer-secret"
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
// The snapshot is refreshed at 05:53 / 11:53 / 17:53 / 23:53 UTC and read once a
// day at 06:41 UTC, so a healthy read is < 1 h old. 26 h = one whole missed day
// plus slack: past it the job has stopped, and a stale 0 is not a measured 0.
const GAP_SNAPSHOT_MAX_AGE_H = 26;
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
//   2. FMV activity gap — editions with a recorded sale but NO FMV (2026-11-14,
//      replaces the "overall coverage < 95 %" flag). Read from the pg_cron
//      snapshot get_fmv_activity_gap() (refresh_fmv_activity_gap, 4x a day).
//      Flags on any such edition, and on a snapshot that is missing or older
//      than GAP_SNAPSHOT_MAX_AGE_H. Overall coverage stays as an informational
//      stat, with and without the one-of-one generative Candy sets.
//      ⚠ No latency figure is quoted here ON PURPOSE — see the block at the
//      call site: the last two numbers in this comment were both dated samples
//      that went wrong in opposite directions.
//   3. badge data freshness (>72h).
//   4. wallet-pack ownership floor — saved wallets whose pack sync completed
//      cleanly but carry no last_clean_sync_at, i.e. the stamping trigger has
//      stopped (check_wallet_pack_sync_floor_drift()). Added 2026-09-20: the
//      guard it watches disarms SILENTLY, and its own SQL pin cannot see the
//      writer because that test sets the column by hand.
// Orphan counts are reported as informational stats only (no flag). Real
// orphan-regression detection would need stored baselines — a separate feature.
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (!bearerMatches(auth, "INGEST_SECRET_TOKEN")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const issues: string[] = [];
  const stats: Record<string, any> = {};

  try {
    // 1. Security invariants — flag any RLS-off or anon-writable PUBLIC base table.
    //    Clean baseline = 0 rows. Degrades safely: on error, reported null, never flagged.
    //
    // ⚠ CONCURRENT WITH THE FLOOR-DRIFT LEG, AND THAT IS LOAD-BEARING, NOT
    // TIDINESS. Every leg in this handler is bounded, but the bounds are SERIAL,
    // so the route's worst case is their SUM — 6 + 8 + 3 + 3 + 3 = 23s against
    // the 30s maxDuration it already died at twice in production. Adding the
    // floor-drift check as a sixth serial leg took that to 29s: still "passing",
    // one second from the wall, and the budget pin caught it. Two cheap check_*
    // RPCs in one Promise.all cost max(6, 6), not 6 + 6, so the worst case is
    // unchanged at 23s. Anything added here later must do the same or raise the
    // budget deliberately.
    const [
      { data: secViolations, error: secErr },
      { data: floorDrift, error: floorErr },
    ] = await Promise.all([
      rpcWithRetry<any[]>(
        supabaseAdmin,
        "check_public_security_invariants",
        {},
        { timeoutMs: SECURITY_RPC_TIMEOUT_MS }
      ),
      rpcWithRetry<any>(
        supabaseAdmin,
        "check_wallet_pack_sync_floor_drift",
        {},
        { timeoutMs: SECURITY_RPC_TIMEOUT_MS }
      ),
    ]);
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

    // 4. The wallet-pack ownership floor (2026-09-20).
    //    get_wallet_pack_history trusts an index ownership claim only at or
    //    after pack_wallet_sync.last_clean_sync_at, which a BEFORE trigger
    //    stamps on every clean walk. That guard fails SILENTLY and in the
    //    comfortable direction: stop stamping and every floor reads NULL, the
    //    guard switches off for every wallet, and packs the user has already
    //    parted with go back to rendering as sealed packs in their inventory.
    //    Nothing throws, and the SQL pin cannot see it — that test sets the
    //    column by hand. This is the only thing watching the writer.
    //    [] = clean. Read the LENGTH; count(*) on a jsonb-array check is 1
    //    either way. Null on error, never a measured zero.
    const floorCount = floorErr ? null : Array.isArray(floorDrift) ? floorDrift.length : 0;
    stats.wallet_pack_sync_floor_drift = floorCount;
    if (floorCount && floorCount > 0) {
      issues.push(
        `${floorCount} saved wallet(s) completed a clean pack sync with no ownership floor — ` +
          `pack_wallet_sync_stamp_clean_floor_trg is not stamping, so wallet inventories ` +
          `can show packs the wallet no longer holds`
      );
    }

    // 2. FMV activity gap (2026-11-14). The flag USED to be "overall coverage
    //    < 95 %", which counts every catalogued edition. 21,009 of Candy's 21,472
    //    editions have never traded (about 10,000 of them one-of-one generative
    //    cards), so it read 76.9 % and fired every day while measuring nothing a
    //    person could act on. The actionable defect is an edition that HAS a sale
    //    and still no FMV (0 on 11-14). An ask alone does not count: a listing is
    //    never FMV, so counting asks would make this permanently non-zero.
    //
    //    That probe costs ~19 s cold (measured 11-14), so it is precomputed by
    //    pg_cron; this reads the latest snapshot. Missing or stale → flagged as
    //    such, never reported as a measured 0. The read itself erroring or
    //    hanging stays UNKNOWN and unflagged, like every other leg here.
    //
    //    The history below is about the OLD get_fmv_coverage() read; it is kept
    //    because the lesson (bound the leg, never quote a latency) still binds.
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
    const { data: gap, error: gapErr } = await rpcWithRetry<any[]>(
      supabaseAdmin,
      "get_fmv_activity_gap",
      {},
      { timeoutMs: COVERAGE_RPC_TIMEOUT_MS }
    );
    stats.fmv_coverage_pct = null;
    stats.fmv_coverage_pct_excl_generative_1of1 = null;
    stats.fmv_activity_gap = null;
    stats.fmv_activity_gap_age_hours = null;
    if (!gapErr && Array.isArray(gap)) {
      if (gap.length === 0) {
        issues.push(
          "FMV activity gap has never been measured — get_fmv_activity_gap() returned no snapshot " +
            "(pg_cron rpc-fmv-activity-gap not running?)"
        );
      } else {
        const sum = (k: string) => gap.reduce((s: number, r: any) => s + Number(r[k] || 0), 0);
        const totEd = sum("editions");
        const totFmv = sum("fmv_editions");
        const genEd = sum("generative_1of1_editions");
        const genFmv = sum("generative_1of1_fmv_editions");
        const pct = (n: number, d: number) => (d > 0 ? Number(((n / d) * 100).toFixed(1)) : null);
        stats.fmv_coverage_pct = pct(totFmv, totEd);
        stats.fmv_coverage_pct_excl_generative_1of1 = pct(totFmv - genFmv, totEd - genEd);
        stats.fmv_coverage_by_collection = Object.fromEntries(
          gap.map((r: any) => [r.slug, pct(Number(r.fmv_editions || 0), Number(r.editions || 0))])
        );
        const soldNoFmv = sum("sold_no_fmv");
        stats.fmv_activity_gap = soldNoFmv;
        const measuredMs = Date.parse(String(gap[0].measured_at));
        const ageH = Number.isFinite(measuredMs)
          ? Number(((Date.now() - measuredMs) / 3_600_000).toFixed(1))
          : null;
        stats.fmv_activity_gap_age_hours = ageH;
        stats.fmv_activity_gap_measured_at = Number.isFinite(measuredMs)
          ? new Date(measuredMs).toISOString()
          : null;
        if (ageH == null || ageH > GAP_SNAPSHOT_MAX_AGE_H) {
          issues.push(
            `FMV activity-gap snapshot is ${ageH == null ? "undated" : `${ageH}h old`} ` +
              `(>${GAP_SNAPSHOT_MAX_AGE_H}h) — its count (${soldNoFmv}) is not a current measurement`
          );
        } else if (soldNoFmv > 0) {
          const by = gap
            .filter((r: any) => Number(r.sold_no_fmv) > 0)
            .map((r: any) => `${r.slug} ${r.sold_no_fmv}`)
            .join(", ");
          issues.push(`${soldNoFmv} edition(s) with a recorded sale but no FMV (${by})`);
        }
      }
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
          `FMV coverage: ${stats.fmv_coverage_pct ?? "?"}% (activity gap ${stats.fmv_activity_gap ?? "?"}), ` +
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
