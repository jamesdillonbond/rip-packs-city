// app/api/cron/weekly-digest/route.ts
//
// Weekly portfolio retention email (P3). Reads get_weekly_portfolio_movers (one
// row per authenticated owner with >= p_days of history, ranked by |Δ FMV|) and
// emails each mover a one-line "your portfolio moved N% this week" nudge via
// Resend.
//
// DISABLED BY DEFAULT. It sends nothing unless WEEKLY_DIGEST_ENABLED === "1".
// This is a proactive outbound email to the dormant early cohort, gated on
// Trevor's explicit go (see CLAUDE.md / memory no-promo-until-launch-ready).
// Deploying the route changes nothing until the flag is set. Scheduling is
// wired separately (cron-job.org) by Cowork on go — this route adds no cron
// entry of its own.
//
// Safety / correctness:
//   • ?dry=1 previews the exact recipient list (after unsubscribe + dedup
//     filtering) and SENDS NOTHING, ignoring the flag — the operator's tool.
//   • Every send carries a working unsubscribe link. We ensure an
//     email_subscribers row per recipient (reusing verification_token as the
//     unsubscribe token) and skip anyone with unsubscribed_at set.
//   • Idempotency via alert_deliveries' UNIQUE (owner_key, channel, alert_kind,
//     subject_key, dedup_bucket): we pre-check for a sent row this week and
//     write the record with status='sent' AFTER the send. status='sent' (never
//     'pending') means the generic alerts-send sender — which only claims
//     'pending' rows — never touches these.
//
// Auth: Bearer ${INGEST_SECRET_TOKEN} or ${CRON_SECRET}. Method: POST or GET.

import { NextRequest, NextResponse, after } from "next/server";
import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PIPELINE_NAME = "weekly-digest";
const FROM = "rpc-alerts@rippackscity.com";
const SUBJECT_KEY = "weekly_portfolio";
const ORIGIN = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com";
const DEFAULT_MIN_ABS_PCT = 5; // start conservative so the email always has a real number
const DEFAULT_DAYS = 7;
const MAX_RECIPIENTS = 1000; // safety cap per run

type Mover = {
  user_id: string;
  email: string | null;
  latest_fmv: number | null;
  prior_fmv: number | null;
  delta_usd: number | null;
  delta_pct: number | null;
  moment_count: number | null;
  latest_date: string | null;
};

function authed(req: NextRequest): boolean {
  const auth = req.headers.get("authorization");
  return (
    auth === `Bearer ${process.env.INGEST_SECRET_TOKEN}` ||
    auth === `Bearer ${process.env.CRON_SECRET}`
  );
}

// Monday (UTC) of the week containing d, as YYYY-MM-DD. Stable weekly dedup key:
// a re-run in the same week is deduped; next week gets a fresh bucket.
function weekBucket(d: Date): string {
  const day = d.getUTCDay(); // 0=Sun .. 6=Sat
  const diff = day === 0 ? -6 : 1 - day; // days back to Monday
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff));
  return monday.toISOString().slice(0, 10);
}

const usd = (n: number | null): string =>
  n == null
    ? "$0.00"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

function pctLabel(p: number | null): string {
  if (p == null) return "0%";
  const sign = p > 0 ? "+" : "";
  return `${sign}${p}%`;
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
    .select("verification_token, unsubscribed_at, digest_weekly")
    .eq("email", email)
    .maybeSingle();

  if (existing) {
    // Respect an explicit opt-out: unsubscribed from everything, or weekly off.
    if (existing.unsubscribed_at || existing.digest_weekly === false) return { skip: true };
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
    digest_weekly: true,
    verified: false, // authed users we're re-engaging; NOT opted-in email subscribers
    verification_token: token,
    unsubscribed_at: null,
  });
  if (error) {
    // Lost an insert race — re-read the winning row.
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

async function alreadySent(ownerKey: string, bucket: string): Promise<boolean> {
  const { data } = await (supabaseAdmin as any)
    .from("alert_deliveries")
    .select("id")
    .eq("owner_key", ownerKey)
    .eq("channel", "email")
    .eq("alert_kind", "weekly_digest")
    .eq("subject_key", SUBJECT_KEY)
    .eq("dedup_bucket", bucket)
    .eq("status", "sent")
    .maybeSingle();
  return !!data;
}

function buildEmail(m: Mover, unsubscribeUrl: string): { subject: string; html: string } {
  const up = (m.delta_usd ?? 0) >= 0;
  const arrow = up ? "▲" : "▼";
  const color = up ? "#16A34A" : "#DC2626";
  const subject = `Your Rip Packs City portfolio: ${pctLabel(m.delta_pct)} this week`;
  const dashUrl = `${ORIGIN}/dashboard`;
  const html = `<!doctype html><html><body style="margin:0;background:#080808;font-family:'Share Tech Mono',Menlo,monospace;color:#fff">
  <div style="max-width:480px;margin:0 auto;padding:32px 24px">
    <h1 style="font-family:'Barlow Condensed',Arial,sans-serif;font-weight:900;letter-spacing:.04em;text-transform:uppercase;font-size:24px;margin:0 0 4px">
      Rip Packs <span style="color:#E03A2F">City</span>
    </h1>
    <p style="color:rgba(255,255,255,0.55);font-size:12px;margin:0 0 24px">Your weekly portfolio</p>

    <div style="border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:20px;margin-bottom:20px">
      <div style="font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:.12em;margin-bottom:6px">Estimated value</div>
      <div style="font-family:'Barlow Condensed',Arial,sans-serif;font-weight:800;font-size:34px;line-height:1">${usd(m.latest_fmv)}</div>
      <div style="font-size:15px;color:${color};margin-top:8px;font-weight:700">
        ${arrow} ${usd(Math.abs(m.delta_usd ?? 0))} (${pctLabel(m.delta_pct)}) this week
      </div>
      <div style="font-size:12px;color:rgba(255,255,255,0.5);margin-top:10px">${m.moment_count ?? 0} moments tracked</div>
    </div>

    <a href="${dashUrl}" style="display:inline-block;background:linear-gradient(135deg,#E03A2F,#B91C1C);color:#fff;text-decoration:none;font-family:'Barlow Condensed',Arial,sans-serif;font-weight:800;letter-spacing:.08em;text-transform:uppercase;font-size:13px;padding:12px 22px;border-radius:6px">
      Open your dashboard →
    </a>

    <p style="color:rgba(255,255,255,0.35);font-size:11px;line-height:1.6;margin:28px 0 0">
      Estimated from indexed sales — not financial advice.<br/>
      <a href="${unsubscribeUrl}" style="color:rgba(255,255,255,0.45)">Unsubscribe from weekly emails</a>
    </p>
  </div></body></html>`;
  return { subject, html };
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

async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY missing");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to, subject, html }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function loadMovers(minAbsPct: number, days: number): Promise<Mover[]> {
  const { data, error } = await (supabaseAdmin as any).rpc("get_weekly_portfolio_movers", {
    p_min_abs_pct: minAbsPct,
    p_days: days,
  });
  if (error) throw new Error(`get_weekly_portfolio_movers: ${error.message}`);
  return ((data ?? []) as Mover[]).filter((m) => m.email && m.email.includes("@"));
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
  const minAbsPct = Number(sp.get("min") ?? DEFAULT_MIN_ABS_PCT) || DEFAULT_MIN_ABS_PCT;
  const days = Number(sp.get("days") ?? DEFAULT_DAYS) || DEFAULT_DAYS;
  const enabled = process.env.WEEKLY_DIGEST_ENABLED === "1";
  const startedAt = new Date().toISOString();
  const bucket = weekBucket(new Date());

  // ── Dry run: preview the exact recipient list (post unsubscribe + dedup), send nothing.
  if (dry) {
    try {
      const movers = await loadMovers(minAbsPct, days);
      const seen = new Set<string>();
      const would: Array<{ email: string; delta_pct: number | null; latest_fmv: number | null }> = [];
      let unsub = 0;
      let dedup = 0;
      for (const m of movers) {
        const email = (m.email as string).toLowerCase();
        if (seen.has(email)) continue;
        seen.add(email);
        const tok = await ensureUnsubTokenPreview(email);
        if (tok === "unsubscribed") { unsub++; continue; }
        if (await alreadySent(m.user_id, bucket)) { dedup++; continue; }
        would.push({ email, delta_pct: m.delta_pct, latest_fmv: m.latest_fmv });
      }
      return NextResponse.json({
        ok: true,
        dry: true,
        enabled,
        bucket,
        min_abs_pct: minAbsPct,
        days,
        movers_total: movers.length,
        would_send: would.length,
        skipped_unsubscribed: unsub,
        skipped_already_sent: dedup,
        recipients: would,
      });
    } catch (e) {
      return NextResponse.json({ ok: false, dry: true, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
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
      const movers = await loadMovers(minAbsPct, days);
      found = movers.length;
      const seen = new Set<string>();

      for (const m of movers) {
        if (sent >= MAX_RECIPIENTS) break;
        const email = (m.email as string).toLowerCase();
        if (seen.has(email)) { skipped++; continue; }
        seen.add(email);

        const tok = await ensureUnsubToken(email);
        if ("skip" in tok) { skipped++; continue; }

        if (await alreadySent(m.user_id, bucket)) { skipped++; continue; }

        const unsubscribeUrl = `${ORIGIN}/api/subscribe/unsubscribe?token=${tok.token}`;
        const { subject, html } = buildEmail(m, unsubscribeUrl);

        try {
          await sendEmail(email, subject, html);
        } catch (e) {
          // Transient send failure: count it, write NO alert_deliveries row, so a
          // later run this week retries the recipient.
          skipped++;
          errMsg = `${errMsg ? errMsg + "; " : ""}send ${email.slice(-8)}: ${e instanceof Error ? e.message : String(e)}`;
          continue;
        }

        const { error: insErr } = await (supabaseAdmin as any).from("alert_deliveries").insert({
          owner_key: m.user_id,
          channel: "email",
          channel_user_id: email,
          alert_kind: "weekly_digest",
          subject_key: SUBJECT_KEY,
          dedup_bucket: bucket,
          payload: {
            latest_fmv: m.latest_fmv,
            delta_usd: m.delta_usd,
            delta_pct: m.delta_pct,
            moment_count: m.moment_count,
            latest_date: m.latest_date,
          },
          status: "sent",
          sent_at: new Date().toISOString(),
        });
        // A unique-violation here means a concurrent run already recorded this
        // bucket — the email went out either way; just don't fail the pipeline.
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
        p_extra: { sent, skipped, bucket, min_abs_pct: minAbsPct, days, duration_ms: Date.now() - startedMs },
      });
    } catch (logErr) {
      console.log(`[${PIPELINE_NAME}] log err: ${logErr instanceof Error ? logErr.message : String(logErr)}`);
    }
  });

  return NextResponse.json({ ok: true, accepted: true, pipeline: PIPELINE_NAME, bucket }, { status: 202 });
}

// Dry-run variant of ensureUnsubToken that never writes: reports whether the
// recipient has opted out (unsubscribed, or weekly digest turned off).
async function ensureUnsubTokenPreview(email: string): Promise<"ok" | "unsubscribed"> {
  const { data } = await (supabaseAdmin as any)
    .from("email_subscribers")
    .select("unsubscribed_at, digest_weekly")
    .eq("email", email)
    .maybeSingle();
  return data?.unsubscribed_at || data?.digest_weekly === false ? "unsubscribed" : "ok";
}
