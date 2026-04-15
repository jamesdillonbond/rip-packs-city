// app/api/check-alerts/route.ts
// Bearer-protected cron endpoint (INGEST_SECRET_TOKEN).
// Calls check_triggered_fmv_alerts RPC, sends email notifications via Resend
// honoring a 6-hour cooldown per alert, then stamps last_triggered_at.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const maxDuration = 60;

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? "";
const RESEND_KEY = process.env.RESEND_API_KEY ?? "";
const FROM = process.env.RPC_ALERTS_FROM || "RPC Alerts <alerts@rippackscity.com>";
const COOLDOWN_MS = 6 * 60 * 60 * 1000;

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
      Manage your alerts at <a href="https://rip-packs-city.vercel.app/profile" style="color:#9ca3af;">rip-packs-city.vercel.app/profile</a>
    </div>
  </div>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
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

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  if (!TOKEN || auth !== `Bearer ${TOKEN}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data, error } = await (supabaseAdmin as any).rpc("check_triggered_fmv_alerts", { p_limit: 100 });
  if (error) {
    console.error("[check-alerts] RPC error", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const total_active = data?.total_active ?? 0;
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
      const sniperUrl = "https://rip-packs-city.vercel.app/nba-top-shot/sniper";
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

  return NextResponse.json({ total_active, total_triggered, emailed, skipped_cooldown, errors });
}
