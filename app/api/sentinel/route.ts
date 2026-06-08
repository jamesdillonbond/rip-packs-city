import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
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

async function sendTelegram(text: string) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
      }
    );
  } catch (e: any) {
    console.error("Telegram send failed:", e.message);
  }
}

async function sendEmail(subject: string, html: string) {
  if (!RESEND_API_KEY || !ALERT_EMAIL) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "RPC Sentinel <onboarding@resend.dev>",
        to: [ALERT_EMAIL],
        subject,
        html,
      }),
    });
  } catch (e: any) {
    console.error("Email send failed:", e.message);
  }
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const checks: HealthCheck[] = [];
  const now = new Date();

  try {
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const { count, error } = await supabase
      .from("sales")
      .select("*", { count: "exact", head: true })
      .gte("ingested_at", twoHoursAgo);
    if (error) {
      checks.push({ name: "Sales Ingest (2h)", status: "critical", detail: `Query error: ${error.message}` });
    } else {
      const salesCount = count || 0;
      checks.push({
        name: "Sales Ingest (2h)",
        status: salesCount > 0 ? "ok" : "critical",
        detail: salesCount > 0
          ? `${salesCount} new sales in last 2 hours`
          : "ZERO sales ingested in last 2 hours - pipeline may be down",
        value: salesCount,
      });
    }
  } catch (e: any) {
    checks.push({ name: "Sales Ingest (2h)", status: "critical", detail: `Exception: ${e.message}` });
  }

  try {
    const { data, error } = await supabase
      .from("fmv_snapshots")
      .select("computed_at")
      .order("computed_at", { ascending: false })
      .limit(1);
    if (error) {
      checks.push({ name: "FMV Freshness", status: "critical", detail: `Query error: ${error.message}` });
    } else if (!data || data.length === 0) {
      checks.push({ name: "FMV Freshness", status: "critical", detail: "No FMV snapshots found at all" });
    } else {
      const latestFmv = new Date(data[0].computed_at);
      const ageHours = (now.getTime() - latestFmv.getTime()) / (1000 * 60 * 60);
      checks.push({
        name: "FMV Freshness",
        status: ageHours < 2 ? "ok" : ageHours < 6 ? "warn" : "critical",
        detail: `Latest FMV snapshot: ${ageHours.toFixed(1)}h ago`,
        value: `${ageHours.toFixed(1)}h`,
      });
    }
  } catch (e: any) {
    checks.push({ name: "FMV Freshness", status: "critical", detail: `Exception: ${e.message}` });
  }

  try {
    // Scope to CANONICAL Top Shot (integer-pair external_id), latest-per-edition.
    // sentinel_fmv_confidence_rows(collection) can only filter by collection_id,
    // so a TS-scoped call still folds in ~6.4k inert UUID dupes (all NO_DATA),
    // depressing HIGH% to a permanently-scary ~3.4% that means nothing. The
    // canonical helper excludes the dupes via the external_id pattern, giving the
    // honest TS quality (HIGH ~5.8%, HIGH+MED ~32%). Threshold is on HIGH+MED so
    // it doesn't go permanently green either — alarms if FMV quality degrades.
    const { data, error } = await supabase.rpc("sentinel_fmv_confidence_canonical_ts");
    if (error) {
      checks.push({ name: "FMV Confidence (canonical TS)", status: "warn", detail: `RPC error (${error.message})` });
    } else if (data) {
      const total = data.reduce((sum: number, r: any) => sum + Number(r.count || 0), 0);
      const high = Number(data.find((r: any) => r.confidence === "HIGH")?.count) || 0;
      const medium = Number(data.find((r: any) => r.confidence === "MEDIUM")?.count) || 0;
      const low = Number(data.find((r: any) => r.confidence === "LOW")?.count) || 0;
      const highPct = total > 0 ? ((high / total) * 100).toFixed(1) : "0";
      const highMedPct = total > 0 ? (((high + medium) / total) * 100).toFixed(1) : "0";
      checks.push({
        name: "FMV Confidence (canonical TS)",
        status: Number(highMedPct) >= 25 ? "ok" : "warn",
        detail: `HIGH: ${high} (${highPct}%) | HIGH+MED: ${highMedPct}% | MED: ${medium} | LOW: ${low} | Canonical TS editions: ${total}`,
        value: `${highMedPct}% high+med`,
      });
    }
  } catch (e: any) {
    checks.push({ name: "FMV Confidence (canonical TS)", status: "warn", detail: `Exception: ${e.message}` });
  }

  try {
    // DISTINCT editions that have a snapshot — NOT total fmv_snapshots rows.
    // fmv_snapshots is history (daily duplicates are intentional), so the old
    // count(rows)/count(editions) read 2105% and could only ever fail if rows <
    // editions (i.e. never — a dead detector). sentinel_fmv_confidence_rows()
    // (no arg = all collections) is DISTINCT ON (edition_id) latest-per-edition,
    // so summing its counts IS the distinct-edition-with-a-snapshot count.
    const { count: editionCount } = await supabase.from("editions").select("*", { count: "exact", head: true });
    const { data: covRows, error: covErr } = await supabase.rpc("sentinel_fmv_confidence_rows");
    const editions = editionCount || 0;
    const fmvEditions = covErr ? 0 : (covRows || []).reduce((s: number, r: any) => s + Number(r.count || 0), 0);
    const coverage = editions > 0 ? ((fmvEditions / editions) * 100).toFixed(1) : "0";
    checks.push({
      name: "Edition Coverage",
      status: covErr ? "warn" : Number(coverage) >= 90 ? "ok" : "warn",
      detail: covErr
        ? `Coverage RPC error: ${covErr.message}`
        : `${fmvEditions} of ${editions} editions have an FMV snapshot (${coverage}%)`,
      value: `${coverage}%`,
    });
  } catch (e: any) {
    checks.push({ name: "Edition Coverage", status: "warn", detail: `Exception: ${e.message}` });
  }

  // TS edition-writer leak tripwire — inert UUID-keyed Top Shot edition rows
  // created in the last 48h. Canonical TS external_id is the integer pair
  // "set:play" (never contains '-'); UUID-keyed rows always do, so '%-%' is an
  // exact proxy for external_id !~ '^[0-9]+:[0-9]+$'. Those rows are made inert
  // by editions_block_topshot_uuid_dupe_trg, so a high count means the GQL
  // ingest writer is hitting the UUID fallback (set.flowId/play.flowID arriving
  // null from searchMarketplaceTransactions). See handoff 2026-05-29 #2/#4.
  try {
    const since48h = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
    const { count: inertUuid } = await supabase
      .from("editions")
      .select("id", { count: "exact", head: true })
      .eq("collection_id", "95f28a17-224a-4025-96ad-adf8a4c63bfd")
      .like("external_id", "%-%")
      .gte("created_at", since48h);
    const n = inertUuid || 0;
    checks.push({
      name: "TS Edition Writer Leak (48h)",
      status: n < 250 ? "ok" : n < 2000 ? "warn" : "critical",
      detail: `${n} inert UUID-keyed TS edition rows created in last 48h (integer-pair "set:play" is canonical; these get nulled by the dupe trigger). High count = ingest GQL writer hitting the UUID fallback.`,
      value: n,
    });
  } catch (e: any) {
    checks.push({ name: "TS Edition Writer Leak (48h)", status: "warn", detail: `Exception: ${e.message}` });
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
    if (error) {
      checks.push({ name: "Pipeline Silence", status: "warn", detail: `RPC error: ${error.message}` });
    } else {
      const stalled: any[] = Array.isArray(data) ? data : [];
      const high = stalled.filter((s) => s.severity === "high");
      const status = high.length > 0 ? "critical" : stalled.length > 0 ? "warn" : "ok";
      const detail =
        stalled.length === 0
          ? "All watchlisted pipelines running within their max-silent window"
          : stalled
              .map((s) => `${s.pipeline} silent ${s.silent_minutes}m (>${s.max_silent_minutes}m, ${s.severity})`)
              .join("; ");
      checks.push({ name: "Pipeline Silence", status, detail, value: stalled.length });
    }
  } catch (e: any) {
    checks.push({ name: "Pipeline Silence", status: "warn", detail: `Exception: ${e.message}` });
  }

  try {
    const { count } = await supabase.from("sales").select("*", { count: "exact", head: true });
    checks.push({ name: "Total Sales", status: "ok", detail: `${(count || 0).toLocaleString()} total sales in database`, value: count || 0 });
  } catch (e: any) {
    checks.push({ name: "Total Sales", status: "warn", detail: `Exception: ${e.message}` });
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
      const tsCount = deals.filter((d: any) => d.source === "topshot").length;
      const flowtyCount = deals.filter((d: any) => d.source === "flowty").length;
      checks.push({
        name: "Sniper Feed",
        status: dealCount > 0 ? "ok" : "warn",
        detail: `${dealCount} deals (TS: ${tsCount}, Flowty: ${flowtyCount})`,
        value: dealCount,
      });
    } else {
      checks.push({ name: "Sniper Feed", status: "critical", detail: `HTTP ${res.status}` });
    }
  } catch (e: any) {
    checks.push({ name: "Sniper Feed", status: "critical", detail: `Timeout or error: ${e.message}` });
  }

  const hasCritical = checks.some((c) => c.status === "critical");
  const hasWarn = checks.some((c) => c.status === "warn");
  const overallStatus = hasCritical ? "CRITICAL" : hasWarn ? "WARN" : "ALL CLEAR";

  const report = { timestamp: now.toISOString(), status: overallStatus, checks, notifications: [] as string[] };

  const hour = now.getUTCHours();
  const isScheduledReport = hour % 6 === 0;
  const shouldNotify = hasCritical || hasWarn || isScheduledReport;

  if (shouldNotify) {
    const emoji = (s: string) => s === "ok" ? "\u2705" : s === "warn" ? "\u26A0\uFE0F" : "\uD83D\uDEA8";
    const statusEmoji = hasCritical ? "\uD83D\uDEA8" : hasWarn ? "\u26A0\uFE0F" : "\u2705";

    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      const tgLines = checks.map((c) => `${emoji(c.status)} <b>${c.name}</b>: ${c.detail}`);
      const tgMsg = `${statusEmoji} <b>RPC Sentinel - ${overallStatus}</b>\n${now.toUTCString()}\n\n${tgLines.join("\n")}`;
      await sendTelegram(tgMsg);
      report.notifications.push("telegram");
    }

    if (RESEND_API_KEY && ALERT_EMAIL) {
      const emailSubject = `${statusEmoji} RPC Sentinel: ${overallStatus}`;
      const rows = checks.map((c) =>
        `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee">${emoji(c.status)}</td><td style="padding:6px 12px;border-bottom:1px solid #eee"><strong>${c.name}</strong></td><td style="padding:6px 12px;border-bottom:1px solid #eee">${c.detail}</td></tr>`
      ).join("");
      const emailHtml = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><h2 style="color:${hasCritical ? "#E03A2F" : hasWarn ? "#F59E0B" : "#22C55E"}">${statusEmoji} Pipeline Sentinel - ${overallStatus}</h2><p style="color:#64748B">${now.toUTCString()}</p><table style="width:100%;border-collapse:collapse;margin-top:16px"><thead><tr style="background:#1E293B;color:white"><th style="padding:8px 12px;text-align:left"></th><th style="padding:8px 12px;text-align:left">Check</th><th style="padding:8px 12px;text-align:left">Detail</th></tr></thead><tbody>${rows}</tbody></table><p style="color:#94A3B8;font-size:12px;margin-top:24px">Rip Packs City - Pipeline Sentinel - Automated Report</p></div>`;
      await sendEmail(emailSubject, emailHtml);
      report.notifications.push("email");
    }

    report.notifications.push("github-actions-native");
  }

  console.log(`SENTINEL ${overallStatus}`, JSON.stringify(report));
  return NextResponse.json(report);
}
