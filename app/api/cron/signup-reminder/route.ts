// app/api/cron/signup-reminder/route.ts
//
// Cold-signup reminder (retention P3). Re-engages approved allow_list users who
// never completed first login — the "chase.standen" pattern: approved,
// prewarmed, welcomed, but never clicked the magic link. Reads the read-only
// SECURITY DEFINER selector get_cold_signup_reminders (status active, no
// auth.users, welcome sent, approved within [p_min_hours, p_max_days]) and emails
// each a one-click "your dashboard is ready" nudge via Resend.
//
// DISABLED BY DEFAULT. It sends nothing unless SIGNUP_REMINDER_ENABLED === "1".
// This is proactive outbound email; it is gated on Trevor's explicit go (see
// CLAUDE.md / memory no-promo-until-launch-ready). Deploying the route changes
// nothing until the flag is set. No cron entry of its own — scheduling is wired
// separately (cron-job.org / vercel.json) on go.
//
// Safety / correctness (mirrors weekly-digest):
//   * ?dry=1 previews the exact recipient list (after unsubscribe + dedup) and
//     SENDS NOTHING, ignoring the flag — the operator's tool.
//   * Every send carries a working unsubscribe link. We ensure an
//     email_subscribers row per recipient (reusing verification_token as the
//     unsubscribe token) and skip anyone with unsubscribed_at set.
//   * Idempotency via alert_deliveries' UNIQUE (owner_key, channel, alert_kind,
//     subject_key, dedup_bucket): owner_key = the lowercased email (cold signups
//     have no auth uid yet), dedup_bucket = the stage (nudge1 / nudge2), so each
//     stage fires at most once per email. We write status='sent' AFTER the send;
//     status='sent' (never 'pending') keeps the generic alerts-send sender —
//     which only claims 'pending' rows — from ever touching these.
//
// Auth: Bearer ${INGEST_SECRET_TOKEN} or ${CRON_SECRET}. Method: POST or GET.

import { NextRequest, NextResponse, after } from "next/server";
import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase";
import {
  buildSignupReminderSubject,
  buildSignupReminderHtml,
  buildSignupReminderText,
} from "@/lib/emails/signup-reminder-email";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PIPELINE_NAME = "signup-reminder";
const FROM = "rpc-alerts@rippackscity.com";
const SUBJECT_KEY = "signup_reminder";
const ALERT_KIND = "signup_reminder";
const ORIGIN = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com";
const DEFAULT_MIN_HOURS = 24;
const DEFAULT_MAX_DAYS = 14;
const MAX_RECIPIENTS = 500; // safety cap per run

type ColdSignup = {
  email: string | null;
  wallet_addr: string | null;
  username: string | null;
  approved_at: string | null;
  hours_since_approved: number | null;
  stage: string | null;
};

function authed(req: NextRequest): boolean {
  const auth = req.headers.get("authorization");
  return (
    auth === `Bearer ${process.env.INGEST_SECRET_TOKEN}` ||
    auth === `Bearer ${process.env.CRON_SECRET}`
  );
}

async function loadEligible(minHours: number, maxDays: number): Promise<ColdSignup[]> {
  const { data, error } = await (supabaseAdmin as any).rpc("get_cold_signup_reminders", {
    p_min_hours: minHours,
    p_max_days: maxDays,
  });
  if (error) throw new Error(`get_cold_signup_reminders: ${error.message}`);
  return ((data ?? []) as ColdSignup[]).filter((r) => r.email && r.email.includes("@"));
}

// Ensure an email_subscribers row exists so the unsubscribe link works, WITHOUT
// clobbering a real subscriber's prefs. Returns the unsubscribe token, or
// { skip: true } if the recipient has unsubscribed.
async function ensureUnsubToken(
  email: string
): Promise<{ token: string } | { skip: true }> {
  const sb = supabaseAdmin as any;
  const { data: existing } = await sb
    .from("email_subscribers")
    .select("verification_token, unsubscribed_at")
    .eq("email", email)
    .maybeSingle();

  if (existing) {
    if (existing.unsubscribed_at) return { skip: true };
    if (existing.verification_token) return { token: existing.verification_token as string };
    const token = randomUUID();
    await sb
      .from("email_subscribers")
      .update({ verification_token: token, updated_at: new Date().toISOString() })
      .eq("email", email);
    return { token };
  }

  const token = randomUUID();
  const { error } = await sb.from("email_subscribers").insert({
    email,
    verified: false, // approved users we're re-engaging; NOT opted-in subscribers
    verification_token: token,
    unsubscribed_at: null,
  });
  if (error) {
    const { data: r2 } = await sb
      .from("email_subscribers")
      .select("verification_token, unsubscribed_at")
      .eq("email", email)
      .maybeSingle();
    if (r2?.unsubscribed_at) return { skip: true };
    return { token: (r2?.verification_token as string) ?? token };
  }
  return { token };
}

async function ensureUnsubTokenPreview(email: string): Promise<"ok" | "unsubscribed"> {
  const { data } = await (supabaseAdmin as any)
    .from("email_subscribers")
    .select("unsubscribed_at")
    .eq("email", email)
    .maybeSingle();
  return data?.unsubscribed_at ? "unsubscribed" : "ok";
}

async function alreadySent(ownerKey: string, stage: string): Promise<boolean> {
  const { data } = await (supabaseAdmin as any)
    .from("alert_deliveries")
    .select("id")
    .eq("owner_key", ownerKey)
    .eq("channel", "email")
    .eq("alert_kind", ALERT_KIND)
    .eq("subject_key", SUBJECT_KEY)
    .eq("dedup_bucket", stage)
    .eq("status", "sent")
    .maybeSingle();
  return !!data;
}

// Per-request cap on the outbound transactional call below.
//
// `fetch()` has NO default timeout, and this work runs inside `after()` under a
// `maxDuration` — where a kill runs neither the success path nor the catch, so
// NO terminal `pipeline_runs` row is written and the outage reads as "the cron
// never fired". Class triage:
// docs/overnight/inbox/2026-08-27T0320Z-unbounded-fetch-is-a-class-29-sites-...
//
// ⭐ 10s is NOT a fresh guess. It is the bound already measured and shipped for
// this SAME upstream in app/api/cron/alerts-send/route.ts, where 276 runs over
// 48h gave avg 1,494 ms and p95 1,644 ms — against one outlier of 58,670 ms
// that came within 1.3 SECONDS of a 60s maxDuration kill. Generous for an API
// that normally answers in ~1.5s.
//
// ⚠ An abort THROWS, which is the shape this caller wants: the send is already
// wrapped per-recipient in try/catch, counted as a failed delivery, and NO
// alert_deliveries row is written — so a later run retries that recipient while
// the rest of the batch continues, instead of one stuck recipient silently
// costing every remaining recipient their email.
const SEND_TIMEOUT_MS = 10_000;

async function sendEmail(to: string, subject: string, html: string, text: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY missing");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to, subject, html, text }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}

async function run(req: NextRequest) {
  if (!authed(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const dry = sp.get("dry") === "1";
  const minHours = Number(sp.get("min_hours") ?? DEFAULT_MIN_HOURS) || DEFAULT_MIN_HOURS;
  const maxDays = Number(sp.get("max_days") ?? DEFAULT_MAX_DAYS) || DEFAULT_MAX_DAYS;
  const enabled = process.env.SIGNUP_REMINDER_ENABLED === "1";
  const startedAt = new Date().toISOString();

  // ── Dry run: preview the exact recipient list (post unsubscribe + dedup), send nothing.
  if (dry) {
    try {
      const rows = await loadEligible(minHours, maxDays);
      const seen = new Set<string>();
      const would: Array<{ email: string; stage: string | null; wallet_addr: string | null }> = [];
      let unsub = 0;
      let dedup = 0;
      for (const r of rows) {
        const email = (r.email as string).toLowerCase();
        const stage = r.stage ?? "nudge1";
        const key = `${email}|${stage}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const tok = await ensureUnsubTokenPreview(email);
        if (tok === "unsubscribed") { unsub++; continue; }
        if (await alreadySent(email, stage)) { dedup++; continue; }
        would.push({ email, stage, wallet_addr: r.wallet_addr });
      }
      return NextResponse.json({
        ok: true,
        dry: true,
        enabled,
        min_hours: minHours,
        max_days: maxDays,
        eligible_total: rows.length,
        would_send: would.length,
        skipped_unsubscribed: unsub,
        skipped_already_sent: dedup,
        recipients: would,
      });
    } catch (e) {
      return NextResponse.json(
        { ok: false, dry: true, error: e instanceof Error ? e.message : String(e) },
        { status: 500 }
      );
    }
  }

  // ── Real run: gated behind the flag.
  if (!enabled) {
    try {
      await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAt,
        p_rows_found: 0,
        p_rows_written: 0,
        p_rows_skipped: 0,
        p_ok: true,
        p_error: null,
        p_extra: { skipped: "disabled" },
      });
    } catch {
      /* non-fatal */
    }
    return NextResponse.json(
      { ok: true, accepted: true, pipeline: PIPELINE_NAME, skipped: "disabled" },
      { status: 202 }
    );
  }

  after(async () => {
    const startedMs = Date.now();
    let ok = true;
    let errMsg: string | null = null;
    let found = 0;
    let sent = 0;
    let skipped = 0;

    try {
      const rows = await loadEligible(minHours, maxDays);
      found = rows.length;
      const seen = new Set<string>();

      for (const r of rows) {
        if (sent >= MAX_RECIPIENTS) break;
        const email = (r.email as string).toLowerCase();
        const stage = r.stage ?? "nudge1";
        const key = `${email}|${stage}`;
        if (seen.has(key)) { skipped++; continue; }
        seen.add(key);

        const tok = await ensureUnsubToken(email);
        if ("skip" in tok) { skipped++; continue; }

        if (await alreadySent(email, stage)) { skipped++; continue; }

        const unsubscribeUrl = `${ORIGIN}/api/subscribe/unsubscribe?token=${tok.token}`;
        const opts = {
          email,
          wallet_addr: r.wallet_addr,
          username: r.username,
          stage,
          unsubscribeUrl,
        };
        const subject = buildSignupReminderSubject(opts);
        const html = buildSignupReminderHtml(opts);
        const text = buildSignupReminderText(opts);

        try {
          await sendEmail(email, subject, html, text);
        } catch (e) {
          // Transient send failure: count it, write NO alert_deliveries row, so a
          // later run retries the recipient.
          skipped++;
          errMsg = `${errMsg ? errMsg + "; " : ""}send ${email.slice(-8)}: ${e instanceof Error ? e.message : String(e)}`;
          continue;
        }

        const { error: insErr } = await (supabaseAdmin as any).from("alert_deliveries").insert({
          owner_key: email,
          channel: "email",
          channel_user_id: email,
          alert_kind: ALERT_KIND,
          subject_key: SUBJECT_KEY,
          dedup_bucket: stage,
          payload: {
            stage,
            wallet_addr: r.wallet_addr,
            approved_at: r.approved_at,
            hours_since_approved: r.hours_since_approved,
          },
          status: "sent",
          sent_at: new Date().toISOString(),
        });
        if (insErr) {
          console.log(`[${PIPELINE_NAME}] delivery record err ${email.slice(-8)}: ${insErr.message}`);
        }
        sent++;
      }
    } catch (e) {
      ok = false;
      errMsg = `${errMsg ? errMsg + "; " : ""}threw: ${e instanceof Error ? e.message : String(e)}`;
    }

    try {
      await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAt,
        p_rows_found: found,
        p_rows_written: sent,
        p_rows_skipped: skipped,
        p_ok: ok,
        p_error: errMsg,
        p_extra: { sent, skipped, min_hours: minHours, max_days: maxDays, duration_ms: Date.now() - startedMs },
      });
    } catch (logErr) {
      console.log(`[${PIPELINE_NAME}] log err: ${logErr instanceof Error ? logErr.message : String(logErr)}`);
    }
  });

  return NextResponse.json({ ok: true, accepted: true, pipeline: PIPELINE_NAME }, { status: 202 });
}
