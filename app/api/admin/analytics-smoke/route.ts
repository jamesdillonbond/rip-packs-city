// app/api/admin/analytics-smoke/route.ts
//
// GET — wraps the analytics_smoke_run() Postgres RPC. The DB fn is fast, but
// the route's additional HTTP checks push total wall-clock past cron-job.org's
// hard 30s client cap, so every tick was marked "Failed (timeout)" and the run
// logged NOTHING to pipeline_runs — server-side success was invisible and the
// job risked auto-disable (CRON-30S, precedent 36eee2f).
//
// Fix: auth stays sync, the smoke work moves into next/server after() and the
// route returns 202 immediately. A log_pipeline_run at the end of the
// background pass (pipeline='analytics-smoke') is the real success signal; a
// fatal-catch surfaces a crash before it.
//
// On overall_severity === 'fail' we fire a Telegram alert with the failing
// check names + detail. Warn-only runs stay quiet — that's nightly noise the
// dashboard surfaces, not a paging event.
//
// Bearer auth via RPC_ADMIN_TOKEN, accepted as either an `Authorization:
// Bearer …` header or a `?token=…` query param (lib/admin-auth.ts handles both).

import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PIPELINE_NAME = "analytics-smoke";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const TELEGRAM_MAX_BODY = 3800;

type SmokeCheck = {
  name: string;
  severity: "ok" | "warn" | "fail";
  ms: number;
  detail: unknown;
};

type SmokeEnvelope = {
  ran_at: string;
  total_ms: number;
  check_count: number;
  fail_count: number;
  warn_count: number;
  overall_severity: "ok" | "warn" | "fail";
  results: SmokeCheck[];
};

function buildAlertText(env: SmokeEnvelope): string {
  const fails = (env.results || []).filter((r) => r.severity === "fail");
  const lines: string[] = [];
  lines.push("RPC Analytics Smoke FAIL");
  lines.push(
    `severity=${env.overall_severity} fail=${env.fail_count} warn=${env.warn_count} of ${env.check_count} checks (${env.total_ms}ms)`
  );
  lines.push(`ran_at=${env.ran_at}`);
  lines.push("");
  for (const f of fails) {
    let detailStr: string;
    try {
      detailStr = JSON.stringify(f.detail);
    } catch {
      detailStr = String(f.detail);
    }
    lines.push(`- ${f.name} (${f.ms}ms)`);
    lines.push(`  ${detailStr}`);
  }
  let body = lines.join("\n");
  if (body.length > TELEGRAM_MAX_BODY) {
    body = body.slice(0, TELEGRAM_MAX_BODY) + "\n…(truncated)";
  }
  return body;
}

async function fireTelegram(text: string): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
      }
    );
    return res.ok;
  } catch (err: any) {
    console.error("[analytics-smoke telegram]", err?.message ?? err);
    return false;
  }
}

async function logRun(
  startedAtIso: string,
  ok: boolean,
  error: string | null,
  envelope: SmokeEnvelope | null,
  durationMs: number,
  extraNote?: Record<string, unknown>
): Promise<void> {
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: envelope?.check_count ?? 0,
      p_rows_written: envelope ? envelope.check_count - envelope.fail_count : 0,
      p_rows_skipped: envelope?.fail_count ?? 0,
      p_ok: ok,
      p_error: error,
      p_collection_slug: null,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: {
        duration_ms: durationMs,
        overall_severity: envelope?.overall_severity ?? null,
        check_count: envelope?.check_count ?? 0,
        fail_count: envelope?.fail_count ?? 0,
        warn_count: envelope?.warn_count ?? 0,
        checks: (envelope?.results ?? []).map((r) => ({
          name: r.name,
          severity: r.severity,
          ms: r.ms,
        })),
        ...(extraNote ?? {}),
      },
    });
  } catch (e) {
    console.error(
      "[analytics-smoke pipeline_runs]",
      e instanceof Error ? e.message : e
    );
  }
}

async function runSmoke(startedAtIso: string, started: number): Promise<void> {
  const { data, error } = await supabaseAdmin.rpc("analytics_smoke_run");

  if (error) {
    console.error("[analytics-smoke rpc]", error.message);
    await logRun(
      startedAtIso,
      false,
      `analytics_smoke_run: ${error.message}`,
      null,
      Date.now() - started
    );
    return;
  }

  const envelope = (data ?? null) as SmokeEnvelope | null;
  if (!envelope) {
    await logRun(
      startedAtIso,
      false,
      "analytics_smoke_run returned null",
      null,
      Date.now() - started
    );
    return;
  }

  let telegramSent = false;
  if (envelope.overall_severity === "fail") {
    telegramSent = await fireTelegram(buildAlertText(envelope));
  }

  await logRun(
    startedAtIso,
    envelope.overall_severity !== "fail",
    envelope.overall_severity === "fail"
      ? `analytics smoke ${envelope.fail_count} fail(s)`
      : null,
    envelope,
    Date.now() - started,
    { telegram_sent: telegramSent }
  );
}

export async function GET(req: NextRequest) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse();

  const started = Date.now();
  const startedAtIso = new Date(started).toISOString();

  // CRON-30S: the route's HTTP checks push total wall-clock past cron-job.org's
  // 30s client cap, so every tick was "Failed (timeout)" and logged nothing.
  // Fire-and-forget in after() + return 202 now; the end-of-run
  // log_pipeline_run is the real signal, and the fatal-catch surfaces a crash.
  after(async () => {
    try {
      await runSmoke(startedAtIso, started);
    } catch (e) {
      await logRun(
        startedAtIso,
        false,
        `smoke crashed: ${e instanceof Error ? e.message : String(e)}`,
        null,
        Date.now() - started,
        { fatal: true }
      );
    }
  });

  return NextResponse.json(
    { accepted: true, pipeline: PIPELINE_NAME },
    { status: 202, headers: { "Cache-Control": "no-store" } }
  );
}
