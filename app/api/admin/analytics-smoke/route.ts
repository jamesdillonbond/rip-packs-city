// app/api/admin/analytics-smoke/route.ts
//
// GET — wraps the analytics_smoke_run() Postgres RPC and returns the full
// envelope (ran_at, total_ms, check_count, fail_count, warn_count,
// overall_severity, results[]) as JSON. Designed to be hit by cron-job.org
// on a recurring schedule; bearer auth via RPC_ADMIN_TOKEN, accepted as
// either an `Authorization: Bearer …` header or a `?token=…` query param
// (lib/admin-auth.ts handles both).
//
// On overall_severity === 'fail' we fire a Telegram alert with the failing
// check names + detail. Warn-only runs stay quiet — that's nightly noise the
// dashboard surfaces, not a paging event.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

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

export async function GET(req: NextRequest) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse();

  const { data, error } = await supabaseAdmin.rpc("analytics_smoke_run");

  if (error) {
    console.error("[analytics-smoke rpc]", error.message);
    return NextResponse.json(
      { error: error.message },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  const envelope = (data ?? null) as SmokeEnvelope | null;
  if (!envelope) {
    return NextResponse.json(
      { error: "analytics_smoke_run returned null" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  let telegramSent = false;
  if (envelope.overall_severity === "fail") {
    telegramSent = await fireTelegram(buildAlertText(envelope));
  }

  return NextResponse.json(
    { ...envelope, telegram_sent: telegramSent },
    { headers: { "Cache-Control": "no-store" } }
  );
}
