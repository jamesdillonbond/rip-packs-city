// app/api/check-alerts/route.ts
// Bearer-protected cron endpoint (INGEST_SECRET_TOKEN).
// 1. Pipeline-health alerts: calls public.get_pipeline_alerts(), emails Trevor
//    on any critical/high alert (60-min debounce via alert_notifications_sent).
// 2. FMV alerts: calls check_triggered_fmv_alerts RPC, sends email notifications
//    via Resend honoring a 6-hour cooldown per alert, stamps last_triggered_at.

import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import crypto from "crypto";

export const maxDuration = 60;

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? "";
const RESEND_KEY = process.env.RESEND_API_KEY ?? "";
const FROM = process.env.RPC_ALERTS_FROM || "RPC Alerts <onboarding@resend.dev>";
const OPS_EMAIL = process.env.ALERT_EMAIL || "tdillonbond@gmail.com";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";
const COOLDOWN_MS = 6 * 60 * 60 * 1000;
const PIPELINE_ALERT_DEBOUNCE_MIN = 60;

function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1000) return "$" + Math.round(n).toLocaleString();
  return "$" + Number(n).toFixed(2);
}

function describeAlert(alert_type: string, threshold: number): string {
  switch (alert_type) {
    case "below_price":
      return `Lowest ask dropped to or below ${fmtUsd(threshold)}`;
    case "below_fmv_pct":
      return `Discount vs FMV reached ${threshold}% or more`;
    case "below_fmv":
      return `FMV dropped below ${fmtUsd(threshold)}`;
    case "above_fmv":
      return `FMV climbed above ${fmtUsd(threshold)}`;
    default:
      return `Threshold ${threshold} hit (${alert_type})`;
  }
}

function buildHtml(a: any, sniperUrl: string): string {
  const desc = describeAlert(a.alert_type, Number(a.threshold));
  const current = a.lowest_ask != null ? fmtUsd(a.lowest_ask) : (a.current_fmv != null ? fmtUsd(a.current_fmv) : "—");
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#0b0b0d;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e8e8ea;">
  <div style="max-width:520px;margin:0 auto;background:#15151a;border:1px solid #26262d;border-radius:12px;overflow:hidden;">
    <div style="padding:20px 24px;border-bottom:1px solid #26262d;">
      <div style="font-size:12px;letter-spacing:0.18em;color:#e03a2f;text-transform:uppercase;font-weight:700;">RPC Alert Triggered</div>
      <h1 style="margin:8px 0 0;font-size:22px;font-weight:700;color:#fff;">${escapeHtml(a.player_name ?? "Moment")}</h1>
      <div style="margin-top:4px;font-size:13px;color:#9ca3af;">${escapeHtml(a.set_name ?? "")}</div>
    </div>
    <div style="padding:20px 24px;">
      <p style="margin:0 0 14px;font-size:14px;color:#cbd5e1;">${escapeHtml(desc)}.</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr><td style="padding:6px 0;color:#9ca3af;">Threshold</td><td style="padding:6px 0;text-align:right;font-family:ui-monospace,Menlo,monospace;color:#fff;">${escapeHtml(String(a.alert_type === "below_fmv_pct" ? a.threshold + "%" : fmtUsd(Number(a.threshold))))}</td></tr>
        <tr><td style="padding:6px 0;color:#9ca3af;">Current price</td><td style="padding:6px 0;text-align:right;font-family:ui-monospace,Menlo,monospace;color:#22c55e;font-weight:700;">${escapeHtml(current)}</td></tr>
        ${a.current_fmv != null ? `<tr><td style="padding:6px 0;color:#9ca3af;">Current FMV</td><td style="padding:6px 0;text-align:right;font-family:ui-monospace,Menlo,monospace;color:#fff;">${escapeHtml(fmtUsd(a.current_fmv))}</td></tr>` : ""}
      </table>
      <div style="margin-top:22px;text-align:center;">
        <a href="${sniperUrl}" style="display:inline-block;background:#e03a2f;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px;font-size:13px;letter-spacing:0.06em;text-transform:uppercase;">View on Sniper</a>
      </div>
    </div>
    <div style="padding:14px 24px;background:#0f0f13;border-top:1px solid #26262d;font-size:11px;color:#6b7280;text-align:center;">
      Manage your alerts at <a href="https://www.rippackscity.com/dashboard" style="color:#9ca3af;">rippackscity.com/dashboard</a>
    </div>
  </div>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

async function sendTelegram(text: string): Promise<{ ok: boolean; error?: string }> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return { ok: false, error: "TELEGRAM_BOT_TOKEN/CHAT_ID not configured" };
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Telegram ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

function buildPipelineAlertTelegram(alerts: PipelineAlert[]): string {
  const header = `🚨 <b>RPC Pipeline Alert</b> — ${alerts.length} active`;
  const lines = alerts.slice(0, 12).map((a) => {
    const sevTag = a.severity === "critical" ? "🔴" : "🟠";
    return `${sevTag} <b>${escapeHtml(a.pipeline)}</b> · ${escapeHtml(a.type)} — ${escapeHtml(a.detail)}`;
  });
  const truncated = alerts.length > 12 ? `\n…and ${alerts.length - 12} more` : "";
  return `${header}\n${lines.join("\n")}${truncated}`;
}

async function sendEmail(to: string, subject: string, html: string): Promise<{ ok: boolean; error?: string }> {
  if (!RESEND_KEY) return { ok: false, error: "RESEND_API_KEY not configured" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to, subject, html }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Resend ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

interface PipelineAlert {
  type: string;
  detail: string;
  pipeline: string;
  severity: string;
}

function buildPipelineAlertHtml(alerts: PipelineAlert[]): string {
  const rows = alerts
    .map(
      (a) => `
      <tr>
        <td style="padding:6px 10px;border:1px solid #26262d;color:${a.severity === "critical" ? "#ef4444" : "#f59e0b"};font-weight:700;text-transform:uppercase;font-size:11px;letter-spacing:0.08em;">${escapeHtml(a.severity)}</td>
        <td style="padding:6px 10px;border:1px solid #26262d;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#fff;">${escapeHtml(a.pipeline)}</td>
        <td style="padding:6px 10px;border:1px solid #26262d;font-size:12px;color:#cbd5e1;">${escapeHtml(a.type)}</td>
        <td style="padding:6px 10px;border:1px solid #26262d;font-size:12px;color:#9ca3af;">${escapeHtml(a.detail)}</td>
      </tr>`
    )
    .join("");
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#0b0b0d;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e8e8ea;">
  <div style="max-width:720px;margin:0 auto;background:#15151a;border:1px solid #26262d;border-radius:12px;overflow:hidden;">
    <div style="padding:20px 24px;border-bottom:1px solid #26262d;">
      <div style="font-size:12px;letter-spacing:0.18em;color:#ef4444;text-transform:uppercase;font-weight:700;">RPC Pipeline Alert</div>
      <h1 style="margin:8px 0 0;font-size:20px;font-weight:700;color:#fff;">${alerts.length} active alert${alerts.length === 1 ? "" : "s"}</h1>
      <div style="margin-top:4px;font-size:13px;color:#9ca3af;">Generated by get_pipeline_alerts() — ${new Date().toISOString()}</div>
    </div>
    <div style="padding:16px 24px;">
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr>
          <th style="padding:6px 10px;border:1px solid #26262d;text-align:left;color:#9ca3af;">Severity</th>
          <th style="padding:6px 10px;border:1px solid #26262d;text-align:left;color:#9ca3af;">Pipeline</th>
          <th style="padding:6px 10px;border:1px solid #26262d;text-align:left;color:#9ca3af;">Type</th>
          <th style="padding:6px 10px;border:1px solid #26262d;text-align:left;color:#9ca3af;">Detail</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="margin-top:16px;font-size:12px;color:#6b7280;">
        60-minute debounce is active — you won't receive this exact alert set again for an hour.
      </div>
    </div>
  </div>
</body></html>`;
}

async function processPipelineAlerts(): Promise<{
  alerts_active: number;
  alerts_critical_or_high: number;
  emails_sent: number;
  telegrams_sent: number;
  debounced: boolean;
  error?: string;
  channel_errors?: { email?: string; telegram?: string };
}> {
  const { data, error } = await (supabaseAdmin as any).rpc("get_pipeline_alerts");
  if (error) {
    console.log(`[check-alerts] get_pipeline_alerts err: ${error.message}`);
    return { alerts_active: 0, alerts_critical_or_high: 0, emails_sent: 0, telegrams_sent: 0, debounced: false, error: error.message };
  }
  const allAlerts: PipelineAlert[] = Array.isArray(data) ? data : [];
  const hot = allAlerts.filter((a) => a.severity === "critical" || a.severity === "high");

  if (hot.length === 0) {
    return { alerts_active: allAlerts.length, alerts_critical_or_high: 0, emails_sent: 0, telegrams_sent: 0, debounced: false };
  }

  const hashInput = JSON.stringify(
    hot
      .map((a) => ({ pipeline: a.pipeline, type: a.type, severity: a.severity }))
      .sort((a, b) => (a.pipeline + a.type).localeCompare(b.pipeline + b.type))
  );
  const alertHash = crypto.createHash("sha256").update(hashInput).digest("hex");

  const cutoff = new Date(Date.now() - PIPELINE_ALERT_DEBOUNCE_MIN * 60 * 1000).toISOString();
  const { data: existing } = await (supabaseAdmin as any)
    .from("alert_notifications_sent")
    .select("alert_hash, sent_at")
    .eq("alert_hash", alertHash)
    .gte("sent_at", cutoff)
    .maybeSingle();

  if (existing) {
    console.log(`[check-alerts] pipeline alerts debounced (hash=${alertHash.slice(0, 10)}, last sent ${existing.sent_at})`);
    return { alerts_active: allAlerts.length, alerts_critical_or_high: hot.length, emails_sent: 0, telegrams_sent: 0, debounced: true };
  }

  const topNames = hot
    .slice(0, 3)
    .map((a) => a.pipeline)
    .join(", ");
  const subject = `[RPC] ${hot.length} pipeline alert${hot.length === 1 ? "" : "s"}: ${topNames}${hot.length > 3 ? "…" : ""}`;

  const [emailRes, telegramRes] = await Promise.all([
    sendEmail(OPS_EMAIL, subject, buildPipelineAlertHtml(hot)),
    sendTelegram(buildPipelineAlertTelegram(hot)),
  ]);

  const channel_errors: { email?: string; telegram?: string } = {};
  if (!emailRes.ok) channel_errors.email = emailRes.error;
  if (!telegramRes.ok) channel_errors.telegram = telegramRes.error;

  if (!emailRes.ok && !telegramRes.ok) {
    console.log(`[check-alerts] pipeline notify failed on all channels — email:${emailRes.error} telegram:${telegramRes.error}`);
    return {
      alerts_active: allAlerts.length,
      alerts_critical_or_high: hot.length,
      emails_sent: 0,
      telegrams_sent: 0,
      debounced: false,
      error: `all channels failed`,
      channel_errors,
    };
  }

  await (supabaseAdmin as any).from("alert_notifications_sent").upsert({
    alert_hash: alertHash,
    sent_at: new Date().toISOString(),
    severity: hot.some((a) => a.severity === "critical") ? "critical" : "high",
    pipeline_count: hot.length,
    body_preview: hot
      .map((a) => `${a.severity}|${a.pipeline}|${a.type}`)
      .join(" • ")
      .slice(0, 500),
  });

  console.log(
    `[check-alerts] pipeline notify — ${hot.length} alerts (hash=${alertHash.slice(0, 10)}) email=${emailRes.ok ? "ok" : "fail"} telegram=${telegramRes.ok ? "ok" : "fail"}`
  );

  return {
    alerts_active: allAlerts.length,
    alerts_critical_or_high: hot.length,
    emails_sent: emailRes.ok ? 1 : 0,
    telegrams_sent: telegramRes.ok ? 1 : 0,
    debounced: false,
    ...(Object.keys(channel_errors).length > 0 ? { channel_errors } : {}),
  };
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  if (!TOKEN || auth !== `Bearer ${TOKEN}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = new Date().toISOString();

  // 202 + after(): the alert sweep does pipeline-alert + FMV-alert work plus
  // outbound email/Telegram and can exceed cron-job.org's 30s client cap under
  // DB saturation. Auth stays sync; the sweep + log_pipeline_run move into
  // after(). The email/Telegram sends and the pipeline_runs row are the real
  // signal, not the HTTP status. Returns 202 immediately.
  after(async () => {
   try {
    const pipelineAlerts = await processPipelineAlerts();

    const { data, error } = await (supabaseAdmin as any).rpc("check_triggered_fmv_alerts", { p_limit: 100 });
    if (error) {
      console.error("[check-alerts] RPC error", error);
      await (supabaseAdmin as any).rpc("log_pipeline_run", {
        p_pipeline: "check-alerts",
        p_started_at: startedAt,
        p_rows_found: pipelineAlerts.alerts_active,
        p_rows_written: pipelineAlerts.emails_sent,
        p_ok: false,
        p_error: `check_triggered_fmv_alerts: ${error.message}`,
        p_extra: { pipeline_alerts: pipelineAlerts },
      });
      return;
    }

    const total_triggered = data?.total_triggered ?? 0;
    const triggered: any[] = Array.isArray(data?.triggered_alerts) ? data.triggered_alerts : [];

    let emailed = 0;
    let skipped_cooldown = 0;
    const errors: { alert_id: string; error: string }[] = [];
    const now = Date.now();

    for (const a of triggered) {
      const last = a.last_triggered_at ? new Date(a.last_triggered_at).getTime() : 0;
      if (last && now - last < COOLDOWN_MS) {
        skipped_cooldown++;
        continue;
      }

      const wantsEmail = a.notification_email && (a.channel === "email" || a.channel === "both");
      if (wantsEmail) {
        const sniperUrl = "https://www.rippackscity.com/nba-top-shot/sniper";
        const subject = `🔔 RPC Alert: ${a.player_name ?? "Moment"} hit your target`;
        const send = await sendEmail(a.notification_email, subject, buildHtml(a, sniperUrl));
        if (send.ok) {
          emailed++;
        } else {
          errors.push({ alert_id: a.alert_id, error: send.error ?? "unknown" });
        }
      }

      const { error: upErr } = await (supabaseAdmin as any)
        .from("fmv_alerts")
        .update({ last_triggered_at: new Date().toISOString() })
        .eq("id", a.alert_id);
      if (upErr) {
        errors.push({ alert_id: a.alert_id, error: `stamp: ${upErr.message}` });
      } else {
        console.log(`[check-alerts] triggered alert=${a.alert_id} player="${a.player_name}" type=${a.alert_type} threshold=${a.threshold}`);
      }
    }

    const pipelineNotifications = (pipelineAlerts.emails_sent ?? 0) + (pipelineAlerts.telegrams_sent ?? 0);
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: "check-alerts",
      p_started_at: startedAt,
      p_rows_found: (pipelineAlerts.alerts_active ?? 0) + total_triggered,
      p_rows_written: pipelineNotifications + emailed,
      p_rows_skipped: skipped_cooldown,
      p_ok: errors.length === 0 && !pipelineAlerts.error,
      p_error: pipelineAlerts.error ?? (errors.length ? `${errors.length} fmv errs` : null),
      p_extra: { pipeline_alerts: pipelineAlerts, fmv_errors: errors.slice(0, 5) },
    });
   } catch (e) {
     // 2026-06-11: top-level fatal-catch — a throw anywhere in the after() body
     // (processPipelineAlerts internals, a thrown check_triggered_fmv_alerts, a
     // thrown fmv_alerts stamp) previously left NO pipeline_runs row, so a real
     // failure looked like silence while cron-job.org acked green. Always log.
     try {
       await (supabaseAdmin as any).rpc("log_pipeline_run", {
         p_pipeline: "check-alerts",
         p_started_at: startedAt,
         p_rows_found: 0,
         p_rows_written: 0,
         p_ok: false,
         p_error: `fatal: ${e instanceof Error ? e.message : String(e)}`,
         p_extra: { fatal: true },
       });
     } catch {
       // best-effort
     }
   }
  });

  return NextResponse.json(
    { ok: true, accepted: true, pipeline: "check-alerts" },
    { status: 202 }
  );
}
