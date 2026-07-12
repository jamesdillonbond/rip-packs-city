// lib/ops-alert.ts
//
// Server-only push helper for OPS/health alerts (the sentinel-bot chat +
// ALERT_EMAIL). Use this when a monitor endpoint detects a red *result* that
// the pipeline-liveness pager (get_pipeline_alerts) can't see — e.g.
// data-integrity found a security-invariant violation, FMV coverage dropped,
// or a smoke test failed while the endpoint itself ran fine.
//
// Two hardening properties the ad-hoc inline senders lacked:
//   1. Delivery is verified (res.ok) and reported per channel — a dead token or
//      a non-2xx is surfaced, never counted as "sent".
//   2. Debounced via ops_alert_should_send(key, cooldown) so a monitor that
//      stays red across many ticks pages once per cooldown, not every run.
//
// This is the OPS plane (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / ALERT_EMAIL),
// distinct from the per-user deal/FMV outbox in lib/alerts.ts. NEVER import
// this into a "use client" component (it uses the service-role client).

import { supabaseAdmin } from "@/lib/supabase";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const ALERT_EMAIL = process.env.ALERT_EMAIL ?? "";
// Verified apex sender (same domain alerts-send delivers from). Never the
// onboarding@resend.dev sandbox address.
const OPS_FROM = process.env.RPC_OPS_FROM || "RPC Ops <noreply@rippackscity.com>";

export interface OpsAlertResult {
  suppressed: boolean; // true ⇒ within cooldown, nothing sent
  telegram: boolean;
  email: boolean;
}

async function sendTelegram(text: string): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
    });
    if (!res.ok) {
      console.error("[ops-alert] telegram non-OK", res.status, (await res.text().catch(() => "")).slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.error("[ops-alert] telegram failed", e instanceof Error ? e.message : String(e));
    return false;
  }
}

async function sendEmail(subject: string, text: string, html?: string): Promise<boolean> {
  if (!RESEND_API_KEY || !ALERT_EMAIL) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: OPS_FROM, to: [ALERT_EMAIL], subject, text, ...(html ? { html } : {}) }),
    });
    if (!res.ok) {
      console.error("[ops-alert] email non-OK", res.status, (await res.text().catch(() => "")).slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.error("[ops-alert] email failed", e instanceof Error ? e.message : String(e));
    return false;
  }
}

/**
 * Push an ops alert to Telegram + email, debounced by `key`.
 * Returns which channels actually accepted the message (or suppressed=true if
 * within the cooldown window). Best-effort: never throws.
 */
export async function sendOpsAlert(opts: {
  key: string;
  subject: string;
  text: string;
  html?: string;
  cooldownMinutes?: number;
}): Promise<OpsAlertResult> {
  const { key, subject, text, html, cooldownMinutes = 180 } = opts;

  // Debounce gate. If the RPC errors, fail OPEN (send) — a broken debounce
  // must not silence a real alert.
  let allowed = true;
  try {
    const { data, error } = await (supabaseAdmin as any).rpc("ops_alert_should_send", {
      p_key: key,
      p_cooldown_minutes: cooldownMinutes,
    });
    if (!error && data === false) allowed = false;
  } catch (e) {
    console.error("[ops-alert] dedup check failed, sending anyway", e instanceof Error ? e.message : String(e));
  }
  if (!allowed) return { suppressed: true, telegram: false, email: false };

  const [telegram, email] = await Promise.all([sendTelegram(text), sendEmail(subject, text, html)]);
  if (!telegram && !email) {
    console.error(`[ops-alert] BOTH channels failed for key=${key} — alert not delivered: ${subject}`);
  }
  return { suppressed: false, telegram, email };
}
