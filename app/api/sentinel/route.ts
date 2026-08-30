import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { redactSecrets } from "@/lib/redact-secrets";

// Explicit Vercel Function budget (GHA-triggered; some use after() fire-and-forget).
// Bumped 60 -> 180 on 2026-08-08: under pooler saturation the ~8 sequential
// health-check DB reads were blowing the 60s cap and 504ing ~88% of runs (7 of 8
// over an 8h window), so the sentinel was failing BLIND — no report, no digest,
// no alerting — most of the day. The GHA caller waits up to 5 min (timeout-minutes:
// 5) so 180s is safely inside it; Pro cap is 800s. A completing-but-slow sentinel
// beats a 504.
//
// ⚠ The follow-up this note used to prescribe — "drop the ingested_at seq-scan" —
// was HALF DONE on 2026-08-13, and the other half must not be done as written.
// Dropping the check would delete the only sales-ingest tripwire that reads the
// sales TABLE instead of pipeline_runs, and that independence is exactly what
// matters: a 403'd edge fn writes no pipeline_runs row at all. It is also not
// redundant with the per-collection arm, which keys on `sold_at` rather than
// `ingested_at`. What was actually done is a partition-key bound that prunes 6
// of 8 partitions on the healthy path (cost 212,454 -> 107,025), with the
// unbounded scan kept for the one case that needs it. See the check itself.
// Still open: per-check timeouts.
export const maxDuration = 180;

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const ALERT_EMAIL = process.env.ALERT_EMAIL || "";

interface HealthCheck {
  name: string;
  status: "ok" | "warn" | "critical";
  detail: string;
  value?: string | number;
}

// A DB statement timeout, connection-pool exhaustion, or fetch abort under DB
// saturation is NOT data loss — it's the DB being slow. A check whose QUERY
// fails this way is INCONCLUSIVE, so it should warn ("db saturated"), not page
// CRITICAL (the 2026-06-10 12:44Z Telegram CRITICAL was 4 parts timeout noise,
// 0 parts data loss). Genuine threshold breaches (zero sales, stale FMV) still
// evaluate normally and stay CRITICAL.
function isSaturationError(msg: string | undefined | null): boolean {
  // Empty/missing message: supabase-js surfaces aborted/undici failures under
  // load as { message: "" }. An empty error can never PROVE data loss, so treat
  // it as inconclusive-saturated (warn), not critical. (2026-07-16: both recent
  // sentinel CRITICAL pages were `Sales Ingest (2h) — Query error: <empty>`
  // false alarms while sales were flowing at 10-20k rows/2h.)
  if (!msg) return true;
  const m = String(msg).toLowerCase();
  return (
    m.includes("statement timeout") ||
    m.includes("canceling statement") ||
    m.includes("connection pool") ||
    m.includes("timeout acquiring") ||
    m.includes("connection terminated") ||
    m.includes("upstream request timeout") ||
    m.includes("fetch failed") ||
    m.includes("the operation was aborted") ||
    m.includes("aborted") ||
    m.includes("57014")
  );
}
const INCONCLUSIVE = "INCONCLUSIVE (db saturated) — ";

// Returns true only when the channel actually accepted the message, so the
// report's `notifications` list reflects real delivery — a dead token or a
// non-2xx must NOT show up as "telegram"/"email" notified (silent-alert-failure
// guard).
// ── WHY A REASON AND NOT A BOOLEAN (2026-08-30) ───────────────────────────
// Observed live: run 33283636751 reported `"notifications":["telegram-FAILED"]`
// on a CRITICAL sweep — the sentinel correctly detected three dead Top Shot
// GraphQL pipelines and could not tell anyone, and WHY went to console.error
// only. From outside, a revoked token, a non-2xx and a thrown fetch were
// indistinguishable. That is CLAUDE.md's alert sub-class exactly: an alert's
// output is silence, so its error is unfalsifiable.
//
// ⚠ The `not_configured` case is now REPORTED rather than skipped. It used to
// sit behind an `if (TOKEN && CHAT_ID)` guard at the call site, so an
// unconfigured channel produced NO entry at all — absence, which reads
// identically to "no notification was needed".
//
// 🚨 Every reason goes through `redactSecrets`, and that is load-bearing rather
// than decorative: the Telegram bot token is IN THE URL PATH, so a thrown fetch
// quoting the URL would write a live credential into `pipeline_runs.extra` and
// into this route's JSON response.
type Delivery = { ok: true } | { ok: false; reason: string };

async function sendTelegram(text: string): Promise<Delivery> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { ok: false, reason: "not_configured" };
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: "HTML",
        }),
      },
    );
    if (!res.ok) {
      const body = redactSecrets((await res.text().catch(() => "")).slice(0, 200));
      console.error("Telegram send non-OK:", res.status, body);
      return { ok: false, reason: `http_${res.status}: ${body}` };
    }
    return { ok: true };
  } catch (e: any) {
    const msg = redactSecrets(e?.message ?? e);
    console.error("Telegram send failed:", msg);
    return { ok: false, reason: `threw: ${msg}` };
  }
}

async function sendEmail(subject: string, html: string): Promise<Delivery> {
  if (!RESEND_API_KEY || !ALERT_EMAIL) return { ok: false, reason: "not_configured" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "RPC Sentinel <noreply@rippackscity.com>",
        to: [ALERT_EMAIL],
        subject,
        html,
      }),
    });
    if (!res.ok) {
      console.error(
        "Email send non-OK:",
        res.status,
        (await res.text().catch(() => "")).slice(0, 200),
      );
      return { ok: false, reason: `http_${res.status}` };
    }
    return { ok: true };
  } catch (e: any) {
    const msg = redactSecrets(e?.message ?? e);
    console.error("Email send failed:", msg);
    return { ok: false, reason: `threw: ${msg}` };
  }
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const checks: HealthCheck[] = [];
  const now = new Date();

  // Table-driven thresholds (audit_20260627_sentinel_threshold_config). A MISSING
  // row falls back to the hardcoded default below (a config gap can never silently
  // disable a check); enabled=false neutralizes the check to ok after evaluation.
  // The route uses the service-role key, so it bypasses the table's RLS.
  const cfgMap: Record<
    string,
    { warn_at: number | null; crit_at: number | null; enabled: boolean }
  > = {};
  try {
    const { data: cfgRows } = await supabase
      .from("sentinel_threshold_config")
      .select("check_name, warn_at, crit_at, enabled");
    for (const r of cfgRows || []) {
      cfgMap[r.check_name] = {
        warn_at:
          r.warn_at === null || r.warn_at === undefined
            ? null
            : Number(r.warn_at),
        crit_at:
          r.crit_at === null || r.crit_at === undefined
            ? null
            : Number(r.crit_at),
        enabled: r.enabled !== false,
      };
    }
  } catch {
    /* config table unreadable -> every check uses its hardcoded fallback */
  }
  // Returns the configured threshold, or `fallback` when the row/value is absent.
  const thr = (
    name: string,
    key: "warn_at" | "crit_at",
    fallback: number,
  ): number => {
    const v = cfgMap[name]?.[key];
    return v === null || v === undefined ? fallback : v;
  };

  // Sales Ingest (2h) — the one tripwire that reads the sales TABLE rather than
  // pipeline_runs, which is exactly why it is worth keeping: a 403'd edge fn
  // writes no pipeline_runs row at all, so a pipeline-log-based check is blind
  // to the outage class this platform keeps hitting (2026-08-11, 24h silent).
  // This check is independent of that log.
  //
  // ⚠ It is NOT superseded by the per-collection arm below, despite reading that
  // way: `sentinel_sales_ingest_health()` keys entirely on `sold_at` (market
  // time), while this keys on `ingested_at` (did we WRITE anything). A history
  // backfill landing 485 rows dated four months ago is invisible to one and
  // plainly visible to the other. Do not delete this as redundant.
  //
  // COST. There is no index on `sales.ingested_at`, so the predicate alone
  // parallel-seq-scans all 8 partitions every run — measured 2026-08-13 at
  // ~2.2 GB per call, 11.7% buffer hit, 28.3 GB over 39.7 h, the largest
  // low-hit-ratio reader on the instance. On a disk-IO-throttled Small tier that
  // is the sentinel's own 504 budget being spent on a check that only fires when
  // EVERYTHING stops.
  //
  // So it runs in two phases:
  //   1. Bound `sold_at` (the PARTITION KEY) to the current year, which lets the
  //      planner prune 6 of 8 partitions — measured cost 212,454 -> 107,025.
  //      This asks the STRICTER question, and deliberately so: "is FORWARD sales
  //      ingest alive". Previously a lone history backfill ticking away satisfied
  //      the check while every forward indexer was dead.
  //   2. Only when phase 1 reads exactly zero — i.e. an incident is already
  //      indicated — pay for the unbounded scan, to separate "forward ingest is
  //      dead" from "everything is dead". That distinction is new; the old check
  //      could not make it at all, and it is the difference between one broken
  //      indexer and a total outage.
  // The 45-day offset on the year floor avoids a New Year cliff: for the first
  // weeks of January, sales sold in late December are still counted.
  try {
    const twoHoursAgo = new Date(
      now.getTime() - 2 * 60 * 60 * 1000,
    ).toISOString();
    const yearFloor = new Date(
      Date.UTC(
        new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000).getUTCFullYear(),
        0,
        1,
      ),
    ).toISOString();
    const salesCrit = thr("Sales Ingest (2h)", "crit_at", 0);

    const { count, error } = await supabase
      .from("sales")
      .select("*", { count: "exact", head: true })
      .gte("ingested_at", twoHoursAgo)
      .gte("sold_at", yearFloor);

    if (error) {
      const sat = isSaturationError(error.message);
      checks.push({
        name: "Sales Ingest (2h)",
        status: sat ? "warn" : "critical",
        detail: `${sat ? INCONCLUSIVE : ""}Query error: ${error.message}`,
      });
    } else {
      const forwardCount = count || 0;
      if (forwardCount > salesCrit) {
        checks.push({
          name: "Sales Ingest (2h)",
          status: "ok",
          detail: `${forwardCount} new sales in last 2 hours`,
          value: forwardCount,
        });
      } else if (forwardCount > 0) {
        // Above zero but under a configured floor — a threshold breach, NOT an
        // outage. Saying "ZERO" here would be a false statement about the data.
        checks.push({
          name: "Sales Ingest (2h)",
          status: "critical",
          detail: `${forwardCount} new sales in last 2 hours - below the configured floor of ${salesCrit}`,
          value: forwardCount,
        });
      } else {
        // Phase 2: genuinely zero forward ingest. Now the expensive scan earns
        // its cost by naming WHICH failure this is.
        let historical: number | null = null;
        let historicalErr: string | null = null;
        try {
          const { count: allCount, error: allErr } = await supabase
            .from("sales")
            .select("*", { count: "exact", head: true })
            .gte("ingested_at", twoHoursAgo);
          if (allErr) historicalErr = allErr.message || "";
          else historical = (allCount || 0) - forwardCount;
        } catch (e2: any) {
          historicalErr = e2?.message || "unknown";
        }
        const detail =
          historicalErr !== null
            ? `ZERO forward sales ingested in last 2 hours - pipeline may be down (historical-backfill probe failed: ${isSaturationError(historicalErr) ? "db saturated" : "error"})`
            : historical && historical > 0
              ? `ZERO forward sales ingested in last 2 hours - forward indexers appear DOWN (${historical} historical backfill rows still landing, so the writer itself is alive)`
              : "ZERO sales ingested in last 2 hours - pipeline may be down";
        checks.push({
          name: "Sales Ingest (2h)",
          status: "critical",
          detail,
          value: 0,
        });
      }
    }
  } catch (e: any) {
    const sat = isSaturationError(e?.message);
    checks.push({
      name: "Sales Ingest (2h)",
      status: sat ? "warn" : "critical",
      detail: `${sat ? INCONCLUSIVE : ""}Exception: ${e.message}`,
    });
  }

  // Per-collection + per-source sales-ingest health (2026-08-08). The aggregate
  // "Sales Ingest (2h)" above is ~92% Top Shot volume and only crits at ZERO
  // total, so it cannot see a silent ingest death in AllDay/Golazos/Candy — and
  // Pinnacle sales live in a separate table it never reads. sentinel_sales_
  // ingest_health() reports EVERY watched collection + per-source lane,
  // index-bounded per collection so it stays cheap under pooler saturation.
  // Silence ceilings + loudness are calibrated per collection in
  // sentinel_ingest_watch (page for TS/AllDay, warn the rest, off for UFC —
  // whose revival is detected by v_rpc_trust_health.ufc_flow_revival_sales_30d).
  let ingestRows: any[] | null = null;
  let ingestErr: string | null = null;
  try {
    const { data, error } = await supabase.rpc("sentinel_sales_ingest_health");
    if (error) throw new Error(error.message);
    ingestRows = Array.isArray(data) ? data : [];
  } catch (e: any) {
    ingestErr = e?.message || "unknown";
  }

  // Sales Ingest by Collection — pages when a page-loud collection (TS/AllDay)
  // goes silent past its calibrated ceiling; warns the rest; UFC (off) and
  // no-history collections never alarm.
  try {
    if (ingestErr) {
      const sat = isSaturationError(ingestErr);
      checks.push({
        name: "Sales Ingest by Collection",
        status: sat ? "warn" : "critical",
        detail: `${sat ? INCONCLUSIVE : ""}RPC error: ${ingestErr}`,
      });
    } else {
      const rank: Record<string, number> = { critical: 0, warn: 1, off: 2 };
      const byColl = new Map<
        string,
        {
          display: string;
          loud: string;
          ceil: number;
          hrs: number | null;
          s24: number;
        }
      >();
      for (const r of ingestRows || []) {
        const key = String(r.collection);
        const cur = byColl.get(key) || {
          display: String(r.display_name ?? key),
          loud: String(r.loudness),
          ceil: Number(r.silence_hours),
          hrs:
            r.coll_hours_since_last == null
              ? null
              : Number(r.coll_hours_since_last),
          s24: 0,
        };
        cur.s24 += Number(r.sales_24h || 0);
        byColl.set(key, cur);
      }
      let worst: "ok" | "warn" | "critical" = "ok";
      const bump = (s: "warn" | "critical") => {
        if (s === "critical" || worst === "ok") worst = s;
      };
      const ordered = [...byColl.values()].sort(
        (a, b) => rank[a.loud] - rank[b.loud] || b.s24 - a.s24,
      );
      const segs = ordered.map((c) => {
        let st: "ok" | "warn" | "critical" = "ok";
        if (c.loud !== "off" && c.hrs != null && c.hrs > c.ceil)
          st = c.loud === "critical" ? "critical" : "warn";
        if (st !== "ok") bump(st);
        const flag = st === "critical" ? "🚨" : st === "warn" ? "⚠️" : "";
        const closed = c.loud === "off" ? " (market closed)" : "";
        const last = c.hrs == null ? "never" : `${c.hrs}h ago`;
        const breach = st !== "ok" ? ` >${c.ceil}h!` : "";
        return `${flag}${c.display} ${c.s24}/24h (last ${last}${breach})${closed}`;
      });
      // ⚠ ZERO COLLECTIONS INSPECTED IS A FAILURE OF THIS ARM, NOT A PASS.
      // `worst` starts at "ok" and only ever moves when a collection breaches, so
      // an EMPTY byColl fell straight through to status "ok" with an empty detail
      // string — a green check that examined nothing. An emptied or mis-filtered
      // sentinel_ingest_watch, or an RPC that returned zero rows, would read as
      // "sales ingest is healthy" forever, and the arm cannot page for a
      // collection it never looked at.
      //
      // This is the same shape as a filtering monitor that exits 0 having matched
      // nothing: "0 breaches in 12 collections" and "0 breaches in 0 collections"
      // are opposite results that rendered identically here. `value` already
      // carried the cardinality, but STATUS is what a reader and the alerting key
      // on, so the count has to move the status.
      if (byColl.size === 0) {
        checks.push({
          name: "Sales Ingest by Collection",
          status: "warn",
          detail:
            "inspected 0 collections — sentinel_sales_ingest_health returned no rows, so this arm evaluated nothing (check sentinel_ingest_watch)",
          value: 0,
        });
      } else {
        checks.push({
          name: "Sales Ingest by Collection",
          status: worst,
          detail: `${segs.join(" · ")} · [${byColl.size} collections inspected]`,
          value: byColl.size,
        });
      }
    }
  } catch (e: any) {
    checks.push({
      name: "Sales Ingest by Collection",
      status: "warn",
      detail: `Exception: ${e.message}`,
    });
  }

  // Sales Ingest by Source — warn-only lane view. A lane dying while its
  // collection still flows (source 24h == 0 but collection active) is the exact
  // failure the rollup can't see. The full per-lane mix is always shown so the
  // digest carries per-marketplace/source metrics for every collection.
  try {
    if (ingestErr) {
      const sat = isSaturationError(ingestErr);
      checks.push({
        name: "Sales Ingest by Source",
        status: "warn",
        detail: `${sat ? INCONCLUSIVE : ""}RPC error: ${ingestErr}`,
      });
    } else {
      const collTotal = new Map<string, number>();
      for (const r of ingestRows || [])
        collTotal.set(
          String(r.collection),
          (collTotal.get(String(r.collection)) || 0) + Number(r.sales_24h || 0),
        );
      const dead: string[] = [];
      const mix: string[] = [];
      for (const r of ingestRows || []) {
        if (String(r.source) === "(none)") continue; // zero-sales collection handled by the rollup check
        const s24 = Number(r.sales_24h || 0);
        mix.push(`${r.display_name}/${r.source}: ${s24}`);
        if (
          String(r.loudness) !== "off" &&
          s24 === 0 &&
          (collTotal.get(String(r.collection)) || 0) > 0
        ) {
          dead.push(`${r.display_name}/${r.source}`);
        }
      }
      checks.push({
        name: "Sales Ingest by Source",
        status: dead.length > 0 ? "warn" : "ok",
        detail:
          dead.length > 0
            ? `LANE SILENT (collection still active): ${dead.join(", ")} | mix(24h): ${mix.join(", ")}`
            : `mix(24h): ${mix.join(", ")}`,
        value: dead.length,
      });
    }
  } catch (e: any) {
    checks.push({
      name: "Sales Ingest by Source",
      status: "warn",
      detail: `Exception: ${e.message}`,
    });
  }

  try {
    const { data, error } = await supabase
      .from("fmv_snapshots")
      .select("computed_at")
      .order("computed_at", { ascending: false })
      .limit(1);
    if (error) {
      const sat = isSaturationError(error.message);
      checks.push({
        name: "FMV Freshness",
        status: sat ? "warn" : "critical",
        detail: `${sat ? INCONCLUSIVE : ""}Query error: ${error.message}`,
      });
    } else if (!data || data.length === 0) {
      checks.push({
        name: "FMV Freshness",
        status: "critical",
        detail: "No FMV snapshots found at all",
      });
    } else {
      const latestFmv = new Date(data[0].computed_at);
      const ageHours = (now.getTime() - latestFmv.getTime()) / (1000 * 60 * 60);
      const fmvWarn = thr("FMV Freshness", "warn_at", 2);
      const fmvCrit = thr("FMV Freshness", "crit_at", 6);
      checks.push({
        name: "FMV Freshness",
        status:
          ageHours < fmvWarn ? "ok" : ageHours < fmvCrit ? "warn" : "critical",
        detail: `Latest FMV snapshot: ${ageHours.toFixed(1)}h ago`,
        value: `${ageHours.toFixed(1)}h`,
      });
    }
  } catch (e: any) {
    const sat = isSaturationError(e?.message);
    checks.push({
      name: "FMV Freshness",
      status: sat ? "warn" : "critical",
      detail: `${sat ? INCONCLUSIVE : ""}Exception: ${e.message}`,
    });
  }

  // Ownership Index Freshness — an OUTCOME check on topshot_ownership (consumer:
  // lib/set-completers-board.ts, the rookie / set-completers surfaces).
  //
  // ⚠ WHY THIS IS NOT A pipeline_cadence_watchlist ROW. On 2026-08-15 and 08-16
  // `ownership-onchain-walk` failed both daily ticks on a pool-acquire timeout,
  // wrote 0 rows, and froze the index at an 08-14 observed_at — while every
  // cadence-shaped instrument read HEALTHY, because the cron fired exactly on
  // time and a FAILING run still writes a pipeline_runs row. `detect_stalled_
  // pipelines()` keys on recency, so it is structurally blind to this. The only
  // question that catches it is "did the data actually get fresher", which is
  // what this asks. Do not "simplify" it into a cadence check.
  //
  // ⚠ TWO WRITERS, and the arm must span both: `ownership-onchain-walk` (daily
  // FCL confirmation walk) and `ownership-sync-dune` (WEEKLY Dune event replay).
  // Reading only the walk would page during a legitimately quiet week that Dune
  // had just refreshed. Note the Dune pipeline LOGS as `ownership-sync-dune`
  // while its route is app/api/cron/sync-topshot-ownership-dune — the log name is
  // the one that matters here, and guessing it from the route yields zero rows
  // (which this arm would then have to treat as an outage).
  //
  // Cost: reads pipeline_runs (~9.5k rows), NOT the 267k-row table. `max(observed_at)`
  // would be the more direct metric but there is no index on that column, so it is a
  // 4,230-buffer seq scan — and adding one is the wrong trade, since the walk upserts
  // observed_at on every row. Verified 2026-08-16 the proxy is exact: the last
  // productive run's timestamp equals max(observed_at) to the millisecond.
  try {
    const OWNERSHIP_WRITERS = ["ownership-onchain-walk", "ownership-sync-dune"];
    const ownWarn = thr("Ownership Index Freshness", "warn_at", 30); // one missed daily tick
    const ownCrit = thr("Ownership Index Freshness", "crit_at", 72); // ~two missed ticks
    const { data: ownRows, error: ownErr } = await supabase
      .from("pipeline_runs")
      .select("pipeline, started_at")
      .in("pipeline", OWNERSHIP_WRITERS)
      .gt("rows_written", 0)
      .order("started_at", { ascending: false })
      .limit(1);
    if (ownErr) {
      const sat = isSaturationError(ownErr.message);
      checks.push({
        name: "Ownership Index Freshness",
        status: sat ? "warn" : "critical",
        detail: `${sat ? INCONCLUSIVE : ""}Query error: ${ownErr.message}`,
      });
    } else if (!ownRows || ownRows.length === 0) {
      // ⚠ NOT healthy, and NOT a number we can state. pipeline_runs prunes at ~73h
      // (prune_pipeline_runs(3)), so an empty result means the last productive write
      // is OLDER than the retention window — i.e. strictly worse than the crit
      // threshold, arriving exactly when the outage has gone on long enough to
      // matter. Treating "no rows" as ok would silence the arm precisely then.
      // pipeline_runs_daily is the indefinite record, so use it to say HOW stale
      // rather than publishing a bound we cannot substantiate.
      let ageDetail = "no productive run within pipeline_runs retention (~73h)";
      try {
        const { data: rollup } = await supabase
          .from("pipeline_runs_daily")
          .select("day")
          .in("pipeline", OWNERSHIP_WRITERS)
          .gt("rows_written", 0)
          .order("day", { ascending: false })
          .limit(1);
        if (rollup && rollup.length > 0) {
          const days = Math.floor(
            (now.getTime() - new Date(`${rollup[0].day}T00:00:00Z`).getTime()) /
              86_400_000,
          );
          ageDetail = `last write ${rollup[0].day} (~${days}d ago)`;
        }
      } catch {
        /* rollup unreadable -> keep the honest retention-bound wording above */
      }
      checks.push({
        name: "Ownership Index Freshness",
        status: "critical",
        detail: `topshot_ownership has no fresh write: ${ageDetail}`,
      });
    } else {
      const ageHours =
        (now.getTime() - new Date(ownRows[0].started_at).getTime()) / 3_600_000;
      checks.push({
        name: "Ownership Index Freshness",
        status:
          ageHours < ownWarn ? "ok" : ageHours < ownCrit ? "warn" : "critical",
        detail: `Last ownership write: ${ageHours.toFixed(1)}h ago (${ownRows[0].pipeline})`,
        value: `${ageHours.toFixed(1)}h`,
      });
    }
  } catch (e: any) {
    const sat = isSaturationError(e?.message);
    checks.push({
      name: "Ownership Index Freshness",
      status: sat ? "warn" : "critical",
      detail: `${sat ? INCONCLUSIVE : ""}Exception: ${e.message}`,
    });
  }

  try {
    // Scope to CANONICAL Top Shot (integer-pair external_id), latest-per-edition,
    // split by printing class. sentinel_fmv_confidence_rows(collection) can only
    // filter by collection_id, so a TS-scoped call still folds in ~6.4k inert UUID
    // dupes (all NO_DATA). The canonical helper excludes the dupes via the
    // external_id pattern; the _split variant further separates BASE (setID:playID)
    // from PARALLEL (::subID) printings. Threshold is on BASE HIGH+MED only:
    // parallels are ~28% of the canonical set, sit at ~10% HIGH+MED because they
    // are rare printings that trade seldom, and are still growing as Stage-B
    // cataloguing proceeds — so a combined ratio FALLS as cataloguing SUCCEEDS and
    // can't be thresholded. Base baseline is ~25% HIGH+MED; a warn there means
    // base-edition FMV quality slipped, which is a real signal.
    const { data, error } = await supabase.rpc(
      "sentinel_fmv_confidence_canonical_ts_split",
    );
    if (error) {
      checks.push({
        name: "FMV Confidence (canonical TS)",
        status: "warn",
        detail: `RPC error (${error.message})`,
      });
    } else if (data) {
      const rows: any[] = data;
      const tally = (printing: string, confidences?: string[]) =>
        rows
          .filter(
            (r) =>
              r.printing === printing &&
              (!confidences || confidences.includes(r.confidence)),
          )
          .reduce((s: number, r: any) => s + Number(r.count || 0), 0);

      const baseTotal = tally("base");
      const parTotal = tally("parallel");
      const total = baseTotal + parTotal;
      const baseHighMed = tally("base", ["HIGH", "MEDIUM"]);
      const parHighMed = tally("parallel", ["HIGH", "MEDIUM"]);
      const pct = (n: number, d: number) =>
        d > 0 ? ((n / d) * 100).toFixed(1) : "0";

      // A population of ZERO is not a share of zero. If the tally came back with
      // no canonical base editions, `pct` would render "0" and the arm would
      // publish "BASE HIGH+MED: 0%" — a measured collapse in accuracy — when the
      // truth is that there was nothing to measure. Those are different claims and
      // only one of them is actionable. Withhold the number.
      if (baseTotal === 0) {
        checks.push({
          name: "FMV Confidence (canonical TS)",
          status: "warn",
          detail:
            `Tally returned no canonical base editions (parallel rows: ${parTotal}). ` +
            `The HIGH+MED share is unmeasurable, not zero.`,
        });
      } else {
        const basePct = Number(pct(baseHighMed, baseTotal));
        checks.push({
          name: "FMV Confidence (canonical TS)",
          status:
            basePct >= thr("FMV Confidence (canonical TS)", "warn_at", 25)
              ? "ok"
              : "warn",
          detail:
            `BASE HIGH+MED: ${pct(baseHighMed, baseTotal)}% (HIGH ${tally("base", ["HIGH"])} of ${baseTotal}) | ` +
            `PARALLEL HIGH+MED: ${pct(parHighMed, parTotal)}% (${parTotal} editions, ~${pct(parTotal, total)}% of canonical) | ` +
            `combined ${pct(baseHighMed + parHighMed, total)}% across ${total}`,
          value: `${basePct}% base high+med`,
        });
      }
    } else {
      // THREE states, not two. `error` null with `data` null is a read that
      // returned no payload — it is NOT an error and it is NOT a zero tally.
      // Without this branch the arm pushed nothing and DISAPPEARED from the
      // sentinel, which is the unfalsifiable-alert class: the headline accuracy
      // metric would read as "not among today's problems" precisely when it
      // could not be read at all. Never substitute a number here.
      checks.push({
        name: "FMV Confidence (canonical TS)",
        status: "warn",
        detail:
          "RPC returned no payload (no error, no rows) — confidence split is unreadable, not zero.",
      });
    }
  } catch (e: any) {
    checks.push({
      name: "FMV Confidence (canonical TS)",
      status: "warn",
      detail: `Exception: ${e.message}`,
    });
  }

  try {
    // DISTINCT live editions that have a snapshot — NOT total fmv_snapshots rows,
    // and NOT count(*) FROM editions (which folds in ~6.5k inert UUID-keyed TS
    // rows the dupe trigger neuters — 24% of the raw denominator that can never
    // legitimately carry an FMV, so it drifts every time the GQL writer leaks one).
    // sentinel_edition_coverage() scopes the denominator to live editions and
    // reports the inert bucket separately.
    const { data: covRows, error: covErr } = await supabase.rpc(
      "sentinel_edition_coverage",
    );
    const rows: any[] = covRows || [];
    const live = rows.find((r) => r.scope === "live");
    const inert = rows.find((r) => r.scope === "inert_ts_uuid");
    const liveEditions = Number(live?.editions || 0);
    const liveWithFmv = Number(live?.with_fmv || 0);
    // Same rule as the confidence arm: a zero DENOMINATOR is not 0% coverage.
    // `liveEditions` is 0 when the RPC came back without a "live" scope row, which
    // is a read that did not deliver — publishing "0%" turns that into a reportable
    // collapse. Emit no percentage at all in that case.
    if (!covErr && liveEditions === 0) {
      checks.push({
        name: "Edition Coverage",
        status: "warn",
        detail:
          "Coverage RPC returned no live-scope row, so the denominator is unknown. " +
          "Coverage is unmeasurable, not zero.",
      });
    } else {
      const coverage =
        liveEditions > 0
          ? ((liveWithFmv / liveEditions) * 100).toFixed(1)
          : "0";
      checks.push({
        name: "Edition Coverage",
        status: covErr
          ? "warn"
          : Number(coverage) >= thr("Edition Coverage", "warn_at", 90)
            ? "ok"
            : "warn",
        detail: covErr
          ? `Coverage RPC error: ${covErr.message}`
          : `${liveWithFmv} of ${liveEditions} live editions have an FMV snapshot (${coverage}%)` +
            ` — excludes ${Number(inert?.editions || 0)} inert UUID-keyed TS rows`,
        value: `${coverage}%`,
      });
    }
  } catch (e: any) {
    checks.push({
      name: "Edition Coverage",
      status: "warn",
      detail: `Exception: ${e.message}`,
    });
  }

  // TS edition-writer leak tripwire — inert UUID-keyed Top Shot edition rows
  // created in the last 48h. Canonical TS external_id is the integer pair
  // "set:play" (never contains '-'); UUID-keyed rows always do, so '%-%' is an
  // exact proxy for external_id !~ '^[0-9]+:[0-9]+$'. Those rows are made inert
  // by editions_block_topshot_uuid_dupe_trg, so a high count means the GQL
  // ingest writer is hitting the UUID fallback (set.flowId/play.flowID arriving
  // null from searchMarketplaceTransactions). See handoff 2026-05-29 #2/#4.
  try {
    const since48h = new Date(
      now.getTime() - 48 * 60 * 60 * 1000,
    ).toISOString();
    // ⚠ THIS TRIPWIRE USED TO REPORT "ok" FROM A FAILED READ, and the `catch`
    // below looks like it covers that and does not.
    //
    // The count was destructured WITHOUT `error`, then `inertUuid || 0` made a
    // failed read `n = 0`, which is `< warn_at` — so the arm published **ok**.
    // supabase-js RESOLVES on a query error rather than throwing, so the
    // surrounding `try/catch` never sees it: the exception branch only fires for
    // a genuine throw. That is the shape CLAUDE.md names — "a guard (`?? 0` on a
    // count makes a check fail OPEN)" — sitting on the sentinel itself, which is
    // the report Trevor actually reads.
    //
    // ⚠ Swept the whole file before changing this one: 13 reads DO destructure
    // `error` (the control), and the other three unchecked ones are safe by
    // design — the threshold-config read falls back to hardcoded defaults *"so a
    // config gap can never silently disable a check"*, the ownership-rollup read
    // only enriches a detail STRING whose default is already the conservative
    // sentence, and a failed suppressions read yields an EMPTY suppression set,
    // which makes MORE arms fire, not fewer. This was the only one that failed
    // open.
    const { count: inertUuid, error: inertErr } = await supabase
      .from("editions")
      .select("id", { count: "exact", head: true })
      .eq("collection_id", "95f28a17-224a-4025-96ad-adf8a4c63bfd")
      .like("external_id", "%-%")
      .gte("created_at", since48h);
    if (inertErr || typeof inertUuid !== "number") {
      // Matches the "Pipeline Success Coverage" convention already in this file:
      // an arm that could not be EVALUATED says so, and is never reported as a
      // measured pass. `value` is omitted rather than zeroed — a fabricated 0
      // here is exactly what made the failure invisible.
      checks.push({
        name: "TS Edition Writer Leak (48h)",
        status: "warn",
        detail: `INCONCLUSIVE — the inert-UUID edition count could not be read (${inertErr?.message ?? "count was not a number"}), so the tripwire was not evaluated.`,
      });
    } else {
      const n = inertUuid;
      const leakWarn = thr("TS Edition Writer Leak (48h)", "warn_at", 250);
      const leakCrit = thr("TS Edition Writer Leak (48h)", "crit_at", 2000);
      checks.push({
        name: "TS Edition Writer Leak (48h)",
        status: n < leakWarn ? "ok" : n < leakCrit ? "warn" : "critical",
        detail: `${n} inert UUID-keyed TS edition rows created in last 48h (integer-pair "set:play" is canonical; these get nulled by the dupe trigger). High count = ingest GQL writer hitting the UUID fallback.`,
        value: n,
      });
    }
  } catch (e: any) {
    checks.push({
      name: "TS Edition Writer Leak (48h)",
      status: "warn",
      detail: `Exception: ${e.message}`,
    });
  }

  // Pipeline SILENCE tripwire — absence-of-runs, not failures. The daytime
  // monitor only scans pipeline_runs for ok=false, so a pipeline whose external
  // (cron-job.org) trigger stops firing goes undetected (e.g. topshot-sales-
  // indexer silent 01:32-08:02 UTC on 2026-05-31). detect_stalled_pipelines()
  // returns active pipeline_cadence_watchlist entries past their
  // max_silent_minutes as JSON rows {pipeline, severity, silent_minutes,
  // max_silent_minutes, last_run}. High-severity stalls page (critical).
  try {
    const { data, error } = await supabase.rpc("detect_stalled_pipelines");
    // ⚠ FAIL CLOSED ON SHAPE. detect_stalled_pipelines returns scalar `jsonb`
    // (pg_proc 2026-08-25), so a non-array payload used to coerce to [] and this
    // tripwire then reported status "ok" with "All watchlisted pipelines running
    // within their max-silent window" — a fabricated healthy claim built out of a
    // payload it could not read. Structurally an array today (its body ends
    // `coalesce(jsonb_agg(...), '[]'::jsonb)`), so this is prospective hardening.
    // Folded into the error branch because a payload this arm cannot parse and an
    // error mean the same thing here: the tripwire did not evaluate.
    if (error || !Array.isArray(data)) {
      const shape = data === null ? "null" : typeof data;
      checks.push({
        name: "Pipeline Silence",
        status: "warn",
        detail: error
          ? `RPC error: ${error.message}`
          : `RPC returned an unexpected payload shape (${shape}, expected array) — the tripwire did not evaluate`,
      });
    } else {
      const stalled: any[] = data;
      const high = stalled.filter((s) => s.severity === "high");
      const status =
        high.length > 0 ? "critical" : stalled.length > 0 ? "warn" : "ok";
      const detail =
        stalled.length === 0
          ? "All watchlisted pipelines running within their max-silent window"
          : stalled
              .map((s) => {
                // ⚠ `silent_minutes` is NULL when detect_stalled_pipelines() found NO
                // run at all in `pipeline_runs`, which retains only ~73h. That is the
                // MOST SEVERE silence this arm can report, and it rendered as the
                // literal string "silent nullm" — which reads as a cosmetic template
                // bug and gets skimmed past, so the worst case was the least legible.
                // Measured 2026-08-22: `candy-editions-ingest` last ran 08-19 08:40Z
                // (three consecutive missed daily ticks, on a collection public since
                // 2026-07-31) and the alert said `silent nullm`.
                //
                // ⚠ DO NOT substitute a number here. The RPC cannot distinguish
                // "stalled past the retention window" from "never ran once", so any
                // figure would be invented — the fabricated-number shape this repo
                // tracks. Name both possibilities instead, and name neither as fact.
                const silence =
                  s.silent_minutes == null
                    ? "silent beyond the pipeline_runs retention window (never ran, or stalled past it)"
                    : `silent ${s.silent_minutes}m`;
                return `${s.pipeline} ${silence} (>${s.max_silent_minutes}m, ${s.severity})`;
              })
              .join("; ");
      checks.push({
        name: "Pipeline Silence",
        status,
        detail,
        value: stalled.length,
      });
    }
  } catch (e: any) {
    checks.push({
      name: "Pipeline Silence",
      status: "warn",
      detail: `Exception: ${e.message}`,
    });
  }

  // Pipeline Success Coverage — the COMPLEMENT of Pipeline Silence above, and the
  // reason it exists is that the two questions are not the same one.
  //
  // ⚠ A cadence arm watches SILENCE, and a FAILING run still writes a
  // pipeline_runs row. So a watchlisted pipeline can fail 100% of its runs for
  // days with every cadence instrument green — the cron fired exactly on time, it
  // just produced nothing once it got there. Measured 2026-08-17: `apply-fmv-
  // haircut` and `match-topshot-players` were BOTH on the active watchlist and
  // BOTH failed every run for 3+ days with nothing firing. `Ownership Index
  // Freshness` above is this same gap solved one pipeline wide; this is that
  // generalized to every watchlisted pipeline.
  //
  // ⚠ THE PREDICATE IS "ZERO SUCCESSES **AND** ZERO ROWS WRITTEN", NOT
  // "fail_count > 0", AND NOT ZERO-SUCCESSES ALONE. Both weaker forms were
  // measured against 20 days of history before this shipped:
  //   - `fail_count > 0` fires constantly on pipelines that are WORKING
  //     (`refresh_wmc_fmv_changed` runs at a 32.6% failure rate and writes
  //     409,110 rows). Useless.
  //   - zero-successes alone produced 4 false positives in 20 days, every one a
  //     pipeline degrading gracefully BY DESIGN: `reconcile-saved-wallet-stats`
  //     reports ok=false on a soft-deadline partial sweep whose work is committed
  //     (wrote 7 and 19 rows on the two days it fired), and `candy-offers-indexer`
  //     likewise (12 and 14 rows).
  // Adding the rows_written guard removed 4 of 4 of those and kept 5 of 5 genuine
  // outages (`match-topshot-players`, `apply-fmv-haircut`, `compute-pinnacle-pack-ev`
  // — all zero-row). That is the same `rows_written > 0` discriminator the
  // Ownership arm turns on, and it is what makes this arm quiet enough to read.
  //
  // ⚠ rows_written is a null instrument ON ITS OWN (dispatchers, heartbeats and MV
  // refreshers legitimately write 0), which is why it is an AND with zero-successes
  // and never a standalone test. A heartbeat that writes nothing but SUCCEEDS
  // cannot fire this arm.
  //
  // Scope is `pipeline_cadence_watchlist WHERE is_active` deliberately — it
  // inherits the operator's existing curation, so the arm cannot fire on something
  // nobody chose to monitor. A pipeline that did not run AT ALL is out of scope by
  // construction (runs = 0): that is Pipeline Silence's job, above.
  //
  // SUPPRESSION is `pipeline_alert_suppression` — the existing, expiring, curated
  // mechanism, reused rather than reinvented, so a known-broken-but-blocked
  // pipeline can be acknowledged for a bounded window:
  //   insert into pipeline_alert_suppression (pipeline, reason, expires_at)
  //   values ('<name>', '<why>', now() + interval '90 days');
  // ⚠ Check what SURVIVES a suppression before writing one: suppressing here does
  // NOT silence Pipeline Silence for that pipeline, so cadence coverage remains.
  //
  // ⚠ SOURCE IS THE ROLLUP, AND IT LAGS. pipeline_runs holds ~3k rows over 24h,
  // which is OVER PostgREST's 1000-row cap — aggregating it directly would
  // silently truncate and make the arm UNDER-report. pipeline_runs_daily is the
  // indefinite rollup, but it refreshes only every 6h (`11 */6 * * *`), so per the
  // standing rule its `refreshed_at` age is stated in the detail on every reading.
  // Consequence: a pipeline that recovered within the last ~6h can still read
  // broken here. Do NOT use this arm to confirm a recovery — read pipeline_runs
  // directly for that.
  //
  // The window is `day >= yesterday`, i.e. 24-48h of wall clock depending on the
  // hour. Wider is the SAFE direction: more elapsed time means more chances for a
  // healthy pipeline to have succeeded once, so the arm gets quieter, never noisier.
  //
  // ⚠ THE WINDOW MUST STAY WIDER THAN THE SLOWEST WATCHLISTED CADENCE, and today it
  // is — measured 2026-08-17, the longest `max_silent_minutes` on the ACTIVE
  // watchlist is 1800 (1.3 days), so every current entry fits inside 24-48h with
  // margin. A pipeline slower than the window FLAPS: it has `runs > 0` only on the
  // day it runs and drops out as `runs = 0` (out of scope, correctly, since that is
  // Pipeline Silence's question) for the rest of its period — so the arm reports it
  // one day in seven and says nothing on the other six.
  // ⚠ That is an ERGONOMIC weakness, NOT a dishonest one, and the distinction is
  // load-bearing because the fix differs. The healthy detail below is scoped to
  // "pipelines THAT RAN since <day>", so on the silent days the arm makes no claim
  // about the absent pipeline — it is not vouching for it. The cost is that you
  // hear about a weekly failure once a week with a six-day gap, which is weaker
  // than continuous coverage but strictly better than no coverage.
  // If a weekly/monthly pipeline is ever watchlisted, take the window from
  // `max_silent_minutes` (e.g. max(48h, 2x cadence)) rather than widening this
  // constant for everyone; the rollup is indefinite so a longer window costs only
  // rows, and the 1000-row cap guard below already covers that.
  // ⚠ There is NO live case today. `topshot-wmc-fossil-drain` was the one candidate
  // (weekly, 3 consecutive zero-output failures) and it was UNSCHEDULED on
  // 2026-08-17 once its fossil population was measured at exactly zero, so it can
  // no longer produce runs at all. The rule above is retained as guidance for the
  // next long-cadence pipeline, NOT as a description of anything currently watched —
  // every active watchlist entry sits inside the window (longest max_silent_minutes
  // measured 2026-08-17: 1800, i.e. 1.3 days).
  // docs/overnight/inbox/2026-08-17T1656Z-the-fossil-drain-times-out-proving-emptiness-and-nothing-watches-it.md
  try {
    const scWarn = thr("Pipeline Success Coverage", "warn_at", 1);
    // 3 = one above the worst 48h window observed in the 20 days to 2026-08-17
    // (max 2, and 0 on 11 of those days) — i.e. "worse than anything yet seen".
    // ⚠ critical FAILS the GHA job, and this repo has already learned what a
    // permanently-red scheduled workflow costs (edge-fn-drift went unread for a
    // week while correctly reporting a real defect). Keep this above the observed
    // ceiling; a single blocked pipeline must never escalate to a red build.
    const scCrit = thr("Pipeline Success Coverage", "crit_at", 3);

    const { data: wlRows, error: wlErr } = await supabase
      .from("pipeline_cadence_watchlist")
      .select("pipeline")
      .eq("is_active", true);
    if (wlErr) throw new Error(`watchlist read: ${wlErr.message}`);
    const watched: string[] = (wlRows ?? [])
      .map((r: any) => r.pipeline)
      .filter(Boolean);

    if (watched.length === 0) {
      // An empty watchlist is not "everything is fine" — it is "we measured
      // nothing". Saying ok here would be the failed-read-renders-as-an-answer
      // class on a monitoring arm.
      checks.push({
        name: "Pipeline Success Coverage",
        status: "warn",
        detail:
          "INCONCLUSIVE — pipeline_cadence_watchlist returned no active rows, so success coverage was not evaluated",
      });
    } else {
      const { data: supRows } = await supabase
        .from("pipeline_alert_suppression")
        .select("pipeline, expires_at");
      // expires_at NULL = permanent suppression; a past expiry is spent.
      const suppressed = new Set<string>(
        (supRows ?? [])
          .filter(
            (r: any) =>
              !r.expires_at || new Date(r.expires_at).getTime() > now.getTime(),
          )
          .map((r: any) => r.pipeline),
      );

      const fromDay = new Date(now.getTime() - 86_400_000)
        .toISOString()
        .slice(0, 10);
      const { data: rollRows, error: rollErr } = await supabase
        .from("pipeline_runs_daily")
        .select(
          "pipeline, runs, ok_count, rows_written, last_error, refreshed_at",
        )
        .gte("day", fromDay)
        .in("pipeline", watched);
      if (rollErr) throw new Error(`rollup read: ${rollErr.message}`);

      const rows: any[] = rollRows ?? [];
      if (rows.length >= 1000) {
        // The documented PostgREST cap. At 2 days x ~83 watched pipelines the real
        // ceiling is ~166, so hitting 1000 means the shape changed underneath this
        // arm and the aggregate below would be computed from a truncated read.
        // Report that rather than publish a count derived from partial data.
        checks.push({
          name: "Pipeline Success Coverage",
          status: "warn",
          detail: `INCONCLUSIVE — pipeline_runs_daily read hit the 1000-row cap (${rows.length}); aggregate would be truncated`,
        });
      } else if (rows.length === 0) {
        checks.push({
          name: "Pipeline Success Coverage",
          status: "warn",
          detail: `INCONCLUSIVE — no pipeline_runs_daily rows since ${fromDay} for ${watched.length} watchlisted pipelines`,
        });
      } else {
        const agg = new Map<
          string,
          { runs: number; oks: number; rw: number; err: string | null }
        >();
        let refreshedAt = 0;
        for (const r of rows) {
          const cur = agg.get(r.pipeline) ?? {
            runs: 0,
            oks: 0,
            rw: 0,
            err: null,
          };
          cur.runs += Number(r.runs ?? 0);
          cur.oks += Number(r.ok_count ?? 0);
          cur.rw += Number(r.rows_written ?? 0);
          cur.err = r.last_error ?? cur.err;
          agg.set(r.pipeline, cur);
          const t = r.refreshed_at ? new Date(r.refreshed_at).getTime() : 0;
          if (t > refreshedAt) refreshedAt = t;
        }

        // ⚠ The watchedSet re-check is deliberate belt-and-braces, not redundancy.
        // Scope is applied server-side by the .in() above, so today this filters
        // nothing — but that makes the arm's ENTIRE scope rest on one clause, and
        // widening or dropping it (or a truncated .in() list) would silently start
        // firing on pipelines nobody chose to monitor. Enforcing membership here
        // too makes the scope a property of the arm rather than of the transport.
        const watchedSet = new Set(watched);
        const dead = [...agg.entries()]
          .filter(
            ([p, a]) =>
              watchedSet.has(p) &&
              a.runs > 0 &&
              a.oks === 0 &&
              a.rw === 0 &&
              !suppressed.has(p),
          )
          .sort((a, b) => b[1].runs - a[1].runs);

        // Stated on every reading, healthy or not — the rollup's recency is part
        // of the answer, not a footnote (a 6h-stale "all clear" is a weaker claim
        // than a fresh one, and the reader cannot tell without this).
        const ageMin = refreshedAt
          ? Math.round((now.getTime() - refreshedAt) / 60_000)
          : null;
        const ageNote =
          ageMin === null ? "rollup age unknown" : `rollup ${ageMin}m old`;
        const suppNote =
          suppressed.size > 0 ? `, ${suppressed.size} suppressed` : "";

        checks.push({
          name: "Pipeline Success Coverage",
          status:
            dead.length >= scCrit
              ? "critical"
              : dead.length >= scWarn
                ? "warn"
                : "ok",
          detail:
            dead.length === 0
              ? `All ${agg.size} watchlisted pipelines that ran since ${fromDay} produced at least one success or wrote rows (${ageNote}${suppNote})`
              : `${dead
                  .map(
                    ([p, a]) =>
                      `${p} 0/${a.runs} ok, 0 rows${a.err ? ` — ${String(a.err).slice(0, 60)}` : ""}`,
                  )
                  .join("; ")} (since ${fromDay}, ${ageNote}${suppNote})`,
          value: dead.length,
        });
      }
    }
  } catch (e: any) {
    const sat = isSaturationError(e?.message);
    checks.push({
      name: "Pipeline Success Coverage",
      status: sat ? "warn" : "critical",
      detail: `${sat ? INCONCLUSIVE : ""}Exception: ${e.message}`,
    });
  }

  // Dune spend (2026-08-22). ⚠ THIS IS THE ONLY PLACE THE DUNE METERS ARE
  // VISIBLE. The credits gauge on dune.com is not the meter that stops us — it
  // read ~900 of 2,500 on 2026-07-19 while the API was already answering
  // `HTTP 402 … configured datapoint limit`. The plan is 1,000,000 datapoints +
  // 2,500 credits per cycle, and ONE ownership walk is 684,498 datapoints
  // (68.4%), so the difference between "on pace" and "the month is gone" is a
  // single run. Warn, never page: exhausting a monthly budget is an operator
  // decision to make, not a 3am wake-up.
  try {
    const { data: dune, error: duneErr } = await supabase.rpc("dune_spend_report");
    if (duneErr) {
      const sat = isSaturationError(duneErr.message);
      checks.push({
        name: "Dune Spend (cycle)",
        status: "warn",
        detail: `${sat ? INCONCLUSIVE : ""}Query error: ${duneErr.message}`,
      });
    } else if (!dune || typeof dune !== "object") {
      // ⚠ An unreadable meter is reported as unreadable. Rendering it as 0%
      // would be the "failed read published as a fact" class, on the one
      // instrument that says whether the month's budget still exists.
      checks.push({
        name: "Dune Spend (cycle)",
        status: "warn",
        detail: "spend report unreadable (no payload)",
      });
    } else {
      const d = dune as Record<string, any>;
      const dpPct = Number(d.cycle_datapoints_pct);
      const elapsedPct = Number(d.cycle_elapsed_pct);
      const creditsLeft = d.credits_est_left == null ? null : Number(d.credits_est_left);
      const creditCap = d.cycle_credit_cap == null ? null : Number(d.cycle_credit_cap);
      const creditPct =
        creditsLeft != null && creditCap ? Math.round(100 * (1 - creditsLeft / creditCap)) : null;
      // Two independent ways to be in trouble, and a lane can be in the second
      // without ever touching the first: spend past the cap, or spend at a rate
      // that reaches it before the cycle ends.
      const overspent = Number.isFinite(dpPct) && dpPct >= 95;
      const offPace = d.on_pace === false && Number.isFinite(dpPct) && dpPct > elapsedPct + 20;
      const creditsGone = creditPct != null && creditPct >= 90;
      const lanes: any[] = Array.isArray(d.by_pipeline) ? d.by_pipeline : [];
      const spent = lanes
        .filter((l) => Number(l.datapoints_cycle) > 0)
        .map((l) => `${l.pipeline}=${Number(l.datapoints_cycle).toLocaleString()}dp`)
        .join(", ");
      checks.push({
        name: "Dune Spend (cycle)",
        status: overspent || creditsGone || offPace ? "warn" : "ok",
        detail:
          `${Number.isFinite(dpPct) ? dpPct : "?"}% of datapoints at ` +
          `${Number.isFinite(elapsedPct) ? elapsedPct : "?"}% of the cycle` +
          (creditPct != null ? `; ~${creditPct}% of credits (est)` : "") +
          `; ${d.days_left_in_cycle ?? "?"}d left` +
          (spent ? `; ${spent}` : "; no lane has spent yet") +
          (offPace ? " — PROJECTED TO EXHAUST BEFORE THE CYCLE ENDS" : ""),
        value: `${Number.isFinite(dpPct) ? dpPct : "?"}%`,
      });
    }
  } catch (e: any) {
    checks.push({
      name: "Dune Spend (cycle)",
      status: "warn",
      detail: `Exception: ${e.message}`,
    });
  }

  // Trust health (2026-07-16): surface v_rpc_trust_health (23 metrics as of
  // 2026-07-27, when the three Candy arms landed) in the
  // sentinel digest — per-collection FMV staleness, impossible-parallel serials,
  // UUID-dupe drift, offer sanity etc. Warn (not page) on breaches: several
  // classes are documented self-healing; the nightly pass owns escalation.
  try {
    const { data: trustRows, error: trustErr } = await supabase
      .from("v_rpc_trust_health")
      .select("metric, value, breach_at, status");
    if (trustErr) {
      const sat = isSaturationError(trustErr.message);
      checks.push({
        name: "Trust Health",
        status: "warn",
        detail: `${sat ? INCONCLUSIVE : ""}Query error: ${trustErr.message}`,
      });
    } else {
      const rows: any[] = trustRows ?? [];
      const breaches = rows.filter((r) => r.status !== "ok");
      checks.push({
        name: "Trust Health",
        status: breaches.length === 0 ? "ok" : "warn",
        detail:
          breaches.length === 0
            ? `${rows.length}/${rows.length} trust metrics ok`
            : breaches
                .map((b) => `${b.metric}=${b.value} (breach at ${b.breach_at})`)
                .join("; "),
        value: `${rows.length - breaches.length}/${rows.length}`,
      });
    }
  } catch (e: any) {
    checks.push({
      name: "Trust Health",
      status: "warn",
      detail: `Exception: ${e.message}`,
    });
  }

  try {
    // Planner-statistics estimate (sentinel_total_sales_estimate): the exact
    // count(*) walked 4.1M+ rows every 30-min tick and read "0 total sales"
    // whenever the count query itself degraded under saturation. An estimate
    // is instant and honest for a monotonic sanity gauge.
    const { data: est, error: estErr } = await supabase.rpc(
      "sentinel_total_sales_estimate",
    );
    const n = Number(est ?? 0);
    checks.push({
      name: "Total Sales",
      status: estErr || !n ? "warn" : "ok",
      detail: estErr
        ? `estimate error: ${estErr.message}`
        : `~${n.toLocaleString()} total sales in database (planner estimate)`,
      value: n,
    });
  } catch (e: any) {
    checks.push({
      name: "Total Sales",
      status: "warn",
      detail: `Exception: ${e.message}`,
    });
  }

  try {
    const sniperUrl = `${process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"}/api/sniper-feed`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    // /api/sniper-feed is NOT in proxy.ts's public list, so an unauthenticated
    // self-fetch 307s to /login and returns the login HTML as 200 — res.json()
    // then throws "Unexpected token '<'" and the catch marked this CRITICAL on
    // EVERY run (masking the real tripwire). proxy.ts honors Bearer first, same
    // as every cron self-call. deals=0 honestly degrades to warn, not critical.
    const res = await fetch(sniperUrl, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${process.env.INGEST_SECRET_TOKEN}` },
    });
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json();
      const deals: any[] = data.deals || [];
      const dealCount = deals.length;
      // SniperDeal.source is "topshot" | "allday" | "golazos" | "pinnacle"
      // (app/api/sniper-feed/route.ts:169). The previous line counted
      // d.source === "flowty" — a value the union cannot produce — so it
      // reported a hardcoded 0 forever. Derive the mix instead, so this stays
      // correct when a collection is added or retired.
      const bySource = deals.reduce(
        (acc: Record<string, number>, d: any) => {
          const s = String(d?.source ?? "unknown");
          acc[s] = (acc[s] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );
      const mix = Object.entries(bySource)
        .sort((a, b) => b[1] - a[1])
        .map(([s, n]) => `${s}: ${n}`)
        .join(", ");
      checks.push({
        name: "Sniper Feed",
        status: dealCount > thr("Sniper Feed", "warn_at", 0) ? "ok" : "warn",
        detail:
          dealCount > 0
            ? `${dealCount} deals (${mix})`
            : "0 deals returned by /api/sniper-feed",
        value: dealCount,
      });
    } else {
      checks.push({
        name: "Sniper Feed",
        status: "critical",
        detail: `HTTP ${res.status}`,
      });
    }
  } catch (e: any) {
    // An 8s AbortError here under DB saturation (the sniper-feed route itself
    // running slow) is inconclusive, not a confirmed outage — don't page.
    const sat = isSaturationError(e?.message) || e?.name === "AbortError";
    checks.push({
      name: "Sniper Feed",
      status: sat ? "warn" : "critical",
      detail: `${sat ? INCONCLUSIVE : ""}Timeout or error: ${e.message}`,
    });
  }

  // ── Detector health: is anyone READING the daily credentialed instruments? ──
  //
  // WHY THIS ARM EXISTS (known-issues #25). Three detectors run daily and are the only
  // things in the estate that can see their rot classes: edge-fn-drift (06:40Z),
  // db-pin-staleness (07:20Z), migration-parity (07:40Z). On 2026-08-22 two of them had
  // been RED for a fortnight while being completely CORRECT — 25 edge functions not
  // running `main`, and 6 of 187 DB pins no longer matching live — and nothing surfaced
  // it. CLAUDE.md already recorded that happening to edge-fn-drift once before.
  //
  // ⚠ A WATCHDOG WORKFLOW WOULD BE THE SAME BUG ONE LEVEL UP — something else nobody
  // reads. It belongs HERE, in the thing that actually pages.
  //
  // ⚠ IT KEYS ON A STREAK, NOT A SINGLE RED. A detector going red for one run is it
  // doing its job; the defect is a red that PERSISTS unread. Consecutive failures are
  // counted from the newest completed run backwards.
  try {
    // ⚠ A DEDICATED VARIABLE ONLY — deliberately NOT falling back to GITHUB_TOKEN.
    // That name is set by GitHub Actions itself and exists in many environments for
    // unrelated reasons (it is set in this repo's own sandbox), so a fallback would
    // make this arm fire live GitHub calls wherever it happened to be defined, with
    // whatever scopes that token carries. Opting in explicitly is the whole point.
    const ghToken = process.env.GITHUB_ACTIONS_READ_TOKEN;
    const WATCHED = ["edge-fn-drift.yml", "db-pin-staleness.yml", "migration-parity.yml"];

    if (!ghToken) {
      // ⚠ NOT a silent skip. An unconfigured arm that says nothing is indistinguishable
      // from a healthy one — which is the exact defect this arm was built to catch, so
      // it must never commit it itself.
      //
      // ⚠ BUT IT IS `ok`, NOT `warn`, AND THAT IS DELIBERATE. A permanently-warn arm
      // drags the whole sentinel to WARN every hour until a token is added, and
      // CLAUDE.md records that a permanently-red instrument is indistinguishable from a
      // broken one at a glance — it would desensitise every OTHER arm in this report.
      // This mirrors the convention already used below for a config-disabled check:
      // forced to ok so it never pages, but VISIBLE and annotated rather than vanishing.
      checks.push({
        name: "Detector Health (GitHub Actions)",
        status: "ok",
        detail:
          "[NOT CONFIGURED] set GITHUB_ACTIONS_READ_TOKEN (a token with actions:read) in Vercel env. " +
          "Until then the three daily detectors (edge-fn-drift, db-pin-staleness, migration-parity) " +
          "are unwatched: a correct one can stay red indefinitely with nobody reading it.",
      });
    } else {
      const streaks: string[] = [];
      const unreadable: string[] = [];
      let worst = 0;

      for (const wf of WATCHED) {
        try {
          const r = await fetch(
            `https://api.github.com/repos/jamesdillonbond/rip-packs-city/actions/workflows/${wf}/runs?branch=main&per_page=12`,
            {
              headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" },
              signal: AbortSignal.timeout(6000),
            },
          );
          if (!r.ok) {
            unreadable.push(`${wf} (HTTP ${r.status})`);
            continue;
          }
          const body: any = await r.json();
          const runs: any[] = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
          const completed = runs.filter((x) => x?.status === "completed");
          if (completed.length === 0) {
            // No completed run is NOT a clean bill of health — it is no evidence.
            unreadable.push(`${wf} (no completed runs)`);
            continue;
          }
          let streak = 0;
          for (const run of completed) {
            if (run?.conclusion === "failure") streak++;
            else break;
          }
          if (streak > 0) streaks.push(`${wf.replace(".yml", "")} ${streak}x`);
          if (streak > worst) worst = streak;
        } catch (e: any) {
          unreadable.push(`${wf} (${e?.name === "TimeoutError" ? "timeout" : e?.message})`);
        }
      }

      const warnAt = thr("Detector Health (GitHub Actions)", "warn_at", 3);
      const critAt = thr("Detector Health (GitHub Actions)", "crit_at", 7);

      // ⚠ A workflow we could not READ is reported, never folded into "healthy". The
      // whole point of this arm is that silence about an instrument is not good news.
      const unreadNote = unreadable.length ? ` | UNREAD: ${unreadable.join(", ")}` : "";

      if (unreadable.length === WATCHED.length) {
        checks.push({
          name: "Detector Health (GitHub Actions)",
          status: "warn",
          detail: `Could not read ANY watched workflow — this arm saw nothing, which is not the same as nothing being wrong.${unreadNote}`,
        });
      } else {
        checks.push({
          name: "Detector Health (GitHub Actions)",
          status: worst >= critAt ? "critical" : worst >= warnAt ? "warn" : unreadable.length ? "warn" : "ok",
          detail: streaks.length
            ? `Consecutive-failure streaks: ${streaks.join(", ")} (warn at ${warnAt}, crit at ${critAt}). ` +
              `A detector red for many days running is usually CORRECT and unread — read the LOG, not the badge.${unreadNote}`
            : `All ${WATCHED.length - unreadable.length} watched detectors green on their latest completed run.${unreadNote}`,
          value: worst,
        });
      }
    }
  } catch (e: any) {
    checks.push({
      name: "Detector Health (GitHub Actions)",
      status: "warn",
      detail: `Exception: ${e?.message}`,
    });
  }

  // A check explicitly disabled via config (enabled=false) is forced to ok so it
  // never pages, but stays in the report (visible, annotated) rather than vanishing.
  for (const c of checks) {
    if (cfgMap[c.name]?.enabled === false && c.status !== "ok") {
      c.status = "ok";
      c.detail = `[check disabled via config] ${c.detail}`;
    }
  }

  const hasCritical = checks.some((c) => c.status === "critical");
  const hasWarn = checks.some((c) => c.status === "warn");
  const overallStatus = hasCritical
    ? "CRITICAL"
    : hasWarn
      ? "WARN"
      : "ALL CLEAR";

  const report = {
    timestamp: now.toISOString(),
    status: overallStatus,
    checks,
    notifications: [] as string[],
  };

  const hour = now.getUTCHours();
  const isScheduledReport = hour % 6 === 0;
  const shouldNotify = hasCritical || hasWarn || isScheduledReport;

  if (shouldNotify) {
    const emoji = (s: string) =>
      s === "ok" ? "\u2705" : s === "warn" ? "\u26A0\uFE0F" : "\uD83D\uDEA8";
    const statusEmoji = hasCritical
      ? "\uD83D\uDEA8"
      : hasWarn
        ? "\u26A0\uFE0F"
        : "\u2705";

    {
      const tgLines = checks.map(
        (c) => `${emoji(c.status)} <b>${c.name}</b>: ${c.detail}`,
      );
      const tgMsg = `${statusEmoji} <b>RPC Sentinel - ${overallStatus}</b>\n${now.toUTCString()}\n\n${tgLines.join("\n")}`;
      const tg = await sendTelegram(tgMsg);
      // ⚠ The reason is appended to the SAME `telegram-FAILED` prefix any
      // existing reader matches on, so nothing that greps for it breaks.
      report.notifications.push(tg.ok ? "telegram" : `telegram-FAILED:${tg.reason}`);
    }

    {
      const emailSubject = `${statusEmoji} RPC Sentinel: ${overallStatus}`;
      const rows = checks
        .map(
          (c) =>
            `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee">${emoji(c.status)}</td><td style="padding:6px 12px;border-bottom:1px solid #eee"><strong>${c.name}</strong></td><td style="padding:6px 12px;border-bottom:1px solid #eee">${c.detail}</td></tr>`,
        )
        .join("");
      const emailHtml = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><h2 style="color:${hasCritical ? "#E03A2F" : hasWarn ? "#F59E0B" : "#22C55E"}">${statusEmoji} Pipeline Sentinel - ${overallStatus}</h2><p style="color:#64748B">${now.toUTCString()}</p><table style="width:100%;border-collapse:collapse;margin-top:16px"><thead><tr style="background:#1E293B;color:white"><th style="padding:8px 12px;text-align:left"></th><th style="padding:8px 12px;text-align:left">Check</th><th style="padding:8px 12px;text-align:left">Detail</th></tr></thead><tbody>${rows}</tbody></table><p style="color:#94A3B8;font-size:12px;margin-top:24px">Rip Packs City - Pipeline Sentinel - Automated Report</p></div>`;
      const em = await sendEmail(emailSubject, emailHtml);
      report.notifications.push(em.ok ? "email" : `email-FAILED:${em.reason}`);
    }

    report.notifications.push("github-actions-native");
  }

  // ── Durable run record (2026-08-29) ───────────────────────────────────────
  // Until today this route wrote NOTHING to pipeline_runs. Its status, its
  // per-check results, and — the part that matters most — whether the Telegram
  // and email alerts actually DELIVERED (`telegram-FAILED` / `email-FAILED`
  // above) existed only in this response body and a console.log. So "did the
  // fleet alarm run, and did anyone hear it?" was unanswerable from any durable
  // store. That is this repo's worst alert sub-class applied to the DELIVERY
  // rather than the condition: the output is silence, so the failure is
  // unfalsifiable.
  //
  // The precedent is its own sibling, not an invention. `stale-fmv-monitor`
  // carried the identical gap until deep-audit D7, and that fix states the rule
  // in its own comment: "A monitor whose own run history is invisible cannot be
  // checked for having run, which is the one thing you need from a monitor."
  // This route is the more important of the two and was missed.
  //
  // ⚠ `ok` means THE SENTINEL RAN, not that the fleet is healthy — the same
  // convention the sibling documents. Read `extra.status` for the verdict. A
  // reader keying on `ok` here learns only that the check completed, which is
  // why the breaching check NAMES are carried out rather than a count (a count
  // reads "no change" across a fix landing and a new arm firing on the same day
  // — diff the SET, not the number).
  //
  // ⛔ Deliberately NOT paired with a `pipeline_cadence_watchlist` row. This
  // route is the thing that READS that table, so an entry for itself is a guard
  // that cannot fire exactly when it is needed: the tick that would notice the
  // silence is the tick that did not happen. The row's value is that any OTHER
  // observer — the daytime monitor, the nightly pass, a human with one query —
  // can now see this route's true invocation cadence, which GitHub's scheduler
  // has been shedding (measured 2026-08-29: 3 firings on a day that asks for 24).
  //
  // rows_* are 0 rather than NULL on purpose: this route genuinely moves no
  // rows, which is a MEASURED zero, not an unmeasured one. `log_pipeline_run`
  // now preserves an explicit NULL, so the distinction is live and the choice
  // has to be deliberate. Matches the sibling exactly.
  try {
    await supabase.rpc("log_pipeline_run", {
      p_pipeline: "sentinel",
      p_started_at: now.toISOString(),
      p_rows_found: 0,
      p_rows_written: 0,
      p_rows_skipped: 0,
      p_ok: true,
      p_error: null,
      p_collection_slug: null,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: {
        status: overallStatus,
        checks_run: checks.length,
        critical: checks.filter((c) => c.status === "critical").map((c) => c.name),
        warn: checks.filter((c) => c.status === "warn").map((c) => c.name),
        notifications: report.notifications,
        duration_ms: Date.now() - now.getTime(),
      },
    });
  } catch (e) {
    // Never let telemetry break the check it is measuring.
    console.error("[sentinel] log_pipeline_run failed:", e);
  }

  console.log(`SENTINEL ${overallStatus}`, JSON.stringify(report));
  return NextResponse.json(report);
}
