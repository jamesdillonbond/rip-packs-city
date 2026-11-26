// app/api/cron/weekly-digest/route.ts
//
// Weekly portfolio retention email (P3). Reads get_weekly_portfolio_movers (one
// row per authenticated owner with >= p_days of history, ranked by |Δ FMV|) and
// emails each mover a one-line "your portfolio moved N% this week" nudge via
// Resend.
//
// DISABLED BY DEFAULT. It sends nothing unless WEEKLY_DIGEST_ENABLED === "1" AND the
// CAN-SPAM postal address (RPC_SENDER_POSTAL_ADDRESS, C2) is set.
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
//     subject_key, dedup_bucket): we pre-check for a sent row this week, then
//     CLAIM the row (status='sending', insert-only) BEFORE the send and mark it
//     'sent' after (claimEmailDelivery, 2026-11-02). Never 'pending', so the generic alerts-send sender — which only claims
//     'pending' rows — never touches these.
//
// Auth: Bearer ${INGEST_SECRET_TOKEN} or ${CRON_SECRET}. Method: POST or GET.

import { bearerMatches } from "@/lib/auth/bearer-secret"
import { NextRequest, NextResponse, after } from "next/server";
import { alreadySentEmail, claimEmailDelivery, ensureUnsubToken } from "@/lib/email/recipient-guards";
import { supabaseAdmin } from "@/lib/supabase";
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat";
import { commercialSendBlockedReason, commercialSenderLine, REPLY_TO } from "@/lib/emails/sender-identity";
import { emailLink } from "@/lib/emails/email-link";
import { buildNewItemsBlock } from "@/lib/emails/weekly-digest-news";
import { buildWeeklyAlertBlock, loadAlertSuggestion, type AlertSuggestion } from "@/lib/emails/alert-suggestion";
import { buildWeeklyPacksBlock, loadPackWeek, weeklyHeadline, type PackWeek } from "@/lib/emails/weekly-packs";
import { buildWeeklyPaniniBlock, loadPaniniWeek, withPanini, type PaniniWeek } from "@/lib/emails/weekly-panini";
import { loadRepricing, repricingDominates, repricingLine, type Repricing } from "@/lib/emails/weekly-repricing";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PIPELINE_NAME = "weekly-digest";
const FROM = "rpc-alerts@rippackscity.com";
const SUBJECT_KEY = "weekly_portfolio";
const ORIGIN = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com";
// 2026-11-17: 0, not 5. At 5 only "movers" were mailed, so a member whose binder held steady heard
// nothing for weeks (11-16: 11 sent of 50 members with a week of history). Every figure printed is
// still a READ value (isCompleteMover), so a +0.4 % week is as honest as a +12 % one.
const DEFAULT_MIN_ABS_PCT = 0;
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
  prior_date: string | null;
};

// 2026-11-03: a mover is mailed only when every figure the email prints was READ. The formatters
// below used to default a missing value ("$0.00", "0%" — in the SUBJECT — "0 moments tracked"):
// on an outbound email to a collector that is an account-level false claim, so an incomplete row
// is skipped and counted (`skipped_incomplete`), never mailed with an invented figure.
type CompleteMover = Mover & { latest_fmv: number; delta_usd: number; delta_pct: number };
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
function isCompleteMover(m: Mover): m is CompleteMover {
  return finite(m.latest_fmv) && finite(m.delta_usd) && finite(m.delta_pct);
}

function authed(req: NextRequest): boolean {
  const auth = req.headers.get("authorization");
  return (
    bearerMatches(auth, "INGEST_SECRET_TOKEN", "CRON_SECRET")
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

const usd = (n: number): string =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

function pctLabel(p: number): string {
  const sign = p > 0 ? "+" : "";
  return `${sign}${p}%`;
}

// #227's known limit, stated rather than hidden: the movers function compares TOTAL estimated value
// week over week, so moments bought or sold that week move the figure too. The function does not
// return the prior moment count, so the email cannot split price change from holdings change — it
// says so instead.
const HOLDINGS_NOTE = "Includes any moments you added or sold this week.";


// ensureUnsubToken / alreadySentEmail live in lib/email/recipient-guards.ts and
// FAIL CLOSED: a read or write they cannot confirm skips the recipient.
async function alreadySent(ownerKey: string, bucket: string): Promise<boolean | null> {
  return alreadySentEmail({ ownerKey, alertKind: "weekly_digest", subjectKey: SUBJECT_KEY, bucket })
}

// 2026-11-20: an optional "Deal alert" block on the player whose moments carry the most value in
// the member's wallet (lib/emails/alert-suggestion.ts); null = no block, the email is unchanged.
// 2026-11-22: an optional "Sealed packs" block (lib/emails/weekly-packs.ts); null = no block.
// 2026-11-22: `repricing` = how much of the week's change is OUR price corrections (lib/emails/weekly-repricing.ts).
// The route only builds an email once that read succeeded; null here = nothing to disclose.
function buildEmail(m: CompleteMover, unsubscribeUrl: string, now: Date = new Date(), alertSuggestion: AlertSuggestion | null = null, packWeek: PackWeek | null = null, repricing: Repricing | null = null, paniniWeek: PaniniWeek | null = null): { subject: string; html: string; text: string } {
  const { html: newsHtml, text: newsText } = buildNewItemsBlock(ORIGIN, now);
  const { html: packsHtml, text: packsText } = buildWeeklyPacksBlock(packWeek);
  const { html: paniniHtml, text: paniniText } = buildWeeklyPaniniBlock(paniniWeek);
  const { html: alertHtml, text: alertText } = buildWeeklyAlertBlock(ORIGIN, alertSuggestion);
  // 2026-11-22: ONE Estimated value — moments + sealed packs (lib/emails/weekly-packs.ts weeklyHeadline).
  // 2026-11-25: plus linked Panini cards (Trevor: Panini "should be" in Portfolio FMV).
  const h = withPanini(weeklyHeadline(m, packWeek), paniniWeek);
  const up = h.deltaUsd >= 0;
  const momentsLine = finite(m.moment_count) ? `${m.moment_count.toLocaleString("en-US")} moments tracked` : null;
  const arrow = up ? "▲" : "▼";
  const color = up ? "#16A34A" : "#DC2626";
  const repriced = repricingLine(repricing);
  // The change line names its scope when it covers the moments only (no like-for-like pack prior).
  const pctPart = h.deltaPct != null ? ` (${pctLabel(h.deltaPct)})` : "";
  const changeLabel = `${usd(Math.abs(h.deltaUsd))}${pctPart} this week${h.scope === "moments" ? " on your moments" : h.scope === "no_cards" ? " on your moments and packs" : ""}`;
  // When our own repricing is at least half of the move, the subject must not headline it as a market %;
  // nor when the % covers only part of the headline total.
  const subject = repricingDominates(repricing, m.delta_usd) || h.scope !== "all" || h.deltaPct == null
    ? "Your Rip Packs City portfolio this week"
    : `Your Rip Packs City portfolio: ${pctLabel(h.deltaPct)} this week`;
  const dashUrl = emailLink(`${ORIGIN}/dashboard`, "weekly_digest", "dashboard");
  const html = `<!doctype html><html><body style="margin:0;background:#080808;font-family:'Share Tech Mono',Menlo,monospace;color:#fff">
  <div style="max-width:480px;margin:0 auto;padding:32px 24px">
    <h1 style="font-family:'Barlow Condensed',Arial,sans-serif;font-weight:900;letter-spacing:.04em;text-transform:uppercase;font-size:24px;margin:0 0 4px">
      Rip Packs <span style="color:#E55A4C">City</span>
    </h1>
    <p style="color:rgba(255,255,255,0.55);font-size:12px;margin:0 0 24px">Your weekly portfolio</p>

    <div style="border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:20px;margin-bottom:20px">
      <div style="font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:.12em;margin-bottom:6px">Estimated value</div>
      <div style="font-family:'Barlow Condensed',Arial,sans-serif;font-weight:800;font-size:34px;line-height:1">${usd(h.valueUsd)}</div>
      <div style="font-size:15px;color:${color};margin-top:8px;font-weight:700">
        ${arrow} ${changeLabel}
      </div>
      ${repriced ? `<div style="font-size:12px;color:rgba(255,255,255,0.75);margin-top:6px">${repriced}</div>` : ""}
      <div style="font-size:11px;color:rgba(255,255,255,0.5);margin-top:6px">${HOLDINGS_NOTE}</div>
      ${momentsLine ? `<div style="font-size:12px;color:rgba(255,255,255,0.5);margin-top:10px">${momentsLine}</div>` : ""}
    </div>
${packsHtml}
${paniniHtml}
${alertHtml}
${newsHtml}
    <a href="${dashUrl}" style="display:inline-block;background:linear-gradient(135deg,#E55A4C,#B91C1C);color:#fff;text-decoration:none;font-family:'Barlow Condensed',Arial,sans-serif;font-weight:800;letter-spacing:.08em;text-transform:uppercase;font-size:13px;padding:12px 22px;border-radius:6px">
      Open your dashboard →
    </a>

    <p style="color:rgba(255,255,255,0.5);font-size:11px;line-height:1.6;margin:28px 0 0">
      Estimated from indexed sales — not financial advice.<br/>
      <a href="${unsubscribeUrl}" style="color:rgba(255,255,255,0.5)">Unsubscribe from weekly emails</a><br/>
      ${commercialSenderLine()}
    </p>
  </div></body></html>`;
  // Plain-text part (2026-10-24): HTML-only mail scores worse with spam filters
  // and is unreadable in text-only clients. Same facts, same order.
  const text = [
    "Rip Packs City — your weekly portfolio",
    "",
    `Estimated value: ${usd(h.valueUsd)}`,
    `${up ? "Up" : "Down"} ${changeLabel}`,
    ...(repriced ? [repriced] : []),
    HOLDINGS_NOTE,
    ...(momentsLine ? [momentsLine] : []),
    ...packsText,
    ...paniniText,
    ...alertText,
    ...newsText,
    "",
    `Open your dashboard: ${dashUrl}`,
    "",
    "Estimated from indexed sales — not financial advice.",
    `Unsubscribe from weekly emails: ${unsubscribeUrl}`,
    commercialSenderLine(),
  ].join("\n");
  return { subject, html, text };
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
// wrapped per-recipient in try/catch, counted as a failed delivery, and its
// alert_deliveries claim is RELEASED — so a later run retries that recipient while
// the rest of the batch continues, instead of one stuck recipient silently
// costing every remaining recipient their email.
const SEND_TIMEOUT_MS = 10_000;

async function sendEmail(to: string, subject: string, html: string, text: string, unsubscribeUrl: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY missing");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM,
      to,
      reply_to: REPLY_TO,
      subject,
      html,
      text,
      // RFC 8058 one-click unsubscribe (Gmail / Yahoo bulk-sender rule);
      // /api/subscribe/unsubscribe accepts the POST.
      headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    }),
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
      const would: Array<{ email: string; delta_pct: number | null; latest_fmv: number | null; alert_player: string | null; sealed_packs_usd: number | null; panini_usd: number | null; repricing_usd: number | null }> = [];
      let unsub = 0;
      let dedup = 0;
      let unverified = 0; // dedup read failed: the live run would skip these too
      let incomplete = 0; // a figure the email prints was not read: the live run skips these
      for (const m of movers) {
        const email = (m.email as string).toLowerCase();
        if (seen.has(email)) continue;
        seen.add(email);
        if (!isCompleteMover(m)) { incomplete++; continue; }
        const tok = await ensureUnsubTokenPreview(email);
        if (tok === "unsubscribed") { unsub++; continue; }
        if (tok === "unverified") { unverified++; continue; }
        const sentBefore = await alreadySent(m.user_id, bucket);
        if (sentBefore === null) { unverified++; continue; }
        if (sentBefore) { dedup++; continue; }
        // A failed repricing read means the email could not say how much of the move is ours: skip, as live does.
        const rp = await loadRepricing(m.user_id, m.prior_date, m.latest_date);
        if (!rp.ok) { incomplete++; continue; }
        const alertSuggestion = await loadAlertSuggestion(m.user_id);
        const packWeek = await loadPackWeek(m.user_id);
        const paniniWeek = await loadPaniniWeek(m.user_id);
        would.push({ email, delta_pct: m.delta_pct, latest_fmv: m.latest_fmv, alert_player: alertSuggestion?.player ?? null, sealed_packs_usd: packWeek?.lowAskUsd ?? null, panini_usd: paniniWeek?.usd ?? null, repricing_usd: rp.repricing.deltaUsd });
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
        skipped_unverified: unverified,
        skipped_incomplete: incomplete,
        recipients: would,
      });
    } catch (e) {
      return NextResponse.json({ ok: false, dry: true, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }

  // ── Real run: gated behind the flag.
  // The flag alone is not enough: a commercial send also needs the CAN-SPAM
  // postal address (C2). Either missing skips the run, logged as such.
  const blocked = commercialSendBlockedReason(enabled);
  if (blocked) {
    const skippedAs = blocked === "flag_off" ? "disabled" : blocked;
    try {
      await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAt,
        p_rows_found: 0,
        p_rows_written: 0,
        p_rows_skipped: 0,
        p_ok: true,
        p_error: null,
        p_extra: { skipped: skippedAs },
      });
    } catch {
      /* non-fatal */
    }
    return NextResponse.json(
      { ok: true, accepted: true, pipeline: PIPELINE_NAME, skipped: skippedAs },
      { status: 202 }
    );
  }

  after(async () => {
    const startedMs = Date.now();
    // INVOCATION MARKER FIRST (deep-audit E5, 2026-11-23). A maxDuration kill runs neither the
    // success path nor the catch, and this route's output is MAIL — a killed tick fails by sending
    // nothing, unfalsifiable from outside. Measured 73 h to 11-23: max 141,685 ms of a 300,000 ms
    // wall (47 %), the tightest margin left on the E5 queue. `<pipeline>-heartbeat` with no terminal
    // row = killed or dropped.
    await writeInvocationHeartbeat({ pipeline: PIPELINE_NAME, startedAtMs: Date.parse(startedAt), extra: { bucket } });
    let ok = true;
    let errMsg: string | null = null;
    let found = 0;
    let sent = 0;
    let skipped = 0;
    let guardErrors = 0;
    let incomplete = 0;

    try {
      const movers = await loadMovers(minAbsPct, days);
      found = movers.length;
      const seen = new Set<string>();

      for (const m of movers) {
        if (sent >= MAX_RECIPIENTS) break;
        const email = (m.email as string).toLowerCase();
        if (seen.has(email)) { skipped++; continue; }
        seen.add(email);
        if (!isCompleteMover(m)) { skipped++; incomplete++; continue; }

        const tok = await ensureUnsubToken(email, { respectDigestOff: true });
        if ("skip" in tok) {
          skipped++;
          if (tok.reason === "error") {
            guardErrors++;
            errMsg = `${errMsg ? errMsg + "; " : ""}guard ${email.slice(-8)}: ${tok.error}`;
          }
          continue;
        }

        const sentBefore = await alreadySent(m.user_id, bucket);
        if (sentBefore === null) {
          skipped++;
          guardErrors++;
          errMsg = `${errMsg ? errMsg + "; " : ""}guard ${email.slice(-8)}: dedup_read_failed`;
          continue;
        }
        if (sentBefore) { skipped++; continue; }

        // 2026-11-22: how much of the move is our own repricing. A failed read is NOT "none": skip the member
        // (incomplete) rather than mail a bare delta that may be mostly our correction.
        const rp = await loadRepricing(m.user_id, m.prior_date, m.latest_date);
        if (!rp.ok) { skipped++; incomplete++; continue; }
        const unsubscribeUrl = `${ORIGIN}/api/subscribe/unsubscribe?token=${tok.token}`;
        const alertSuggestion = await loadAlertSuggestion(m.user_id);
        const packWeek = await loadPackWeek(m.user_id);
        const paniniWeek = await loadPaniniWeek(m.user_id);
        const { subject, html, text } = buildEmail(m, unsubscribeUrl, new Date(), alertSuggestion, packWeek, rp.repricing, paniniWeek);

        // ⛔ CLAIM BEFORE SEND (2026-11-02): the delivery row used to be written AFTER
        // the send with a failed insert only logged, so overlapping runs — or any run
        // after a failed record — mailed the recipient again. Claim first (insert-only
        // on the unique key); held = another run owns it; a claim error fails closed.
        const claim = await claimEmailDelivery({
          ownerKey: m.user_id, channelUserId: email, alertKind: "weekly_digest", subjectKey: SUBJECT_KEY, bucket: bucket,
          payload: { latest_fmv: m.latest_fmv, delta_usd: m.delta_usd, delta_pct: m.delta_pct, moment_count: m.moment_count, latest_date: m.latest_date, alert_player: alertSuggestion?.player ?? null, repricing_usd: rp.repricing.deltaUsd },
          log: (msg) => console.log(`[${PIPELINE_NAME}] ${msg}`),
        });
        if (claim.state === "held") { skipped++; continue; }
        if (claim.state === "error") {
          skipped++;
          guardErrors++;
          errMsg = `${errMsg ? errMsg + "; " : ""}guard ${email.slice(-8)}: ${claim.error}`;
          continue;
        }

        try {
          await sendEmail(email, subject, html, text, unsubscribeUrl);
        } catch (e) {
          // Transient send failure: RELEASE the claim, so a later run retries the recipient.
          await claim.release();
          skipped++;
          errMsg = `${errMsg ? errMsg + "; " : ""}send ${email.slice(-8)}: ${e instanceof Error ? e.message : String(e)}`;
          continue;
        }
        await claim.markSent();
        sent++;
      }
    } catch (e) {
      ok = false;
      errMsg = `${errMsg ? errMsg + "; " : ""}threw: ${e instanceof Error ? e.message : String(e)}`;
    }

    try {
      // supabase-js RETURNS errors rather than throwing (R123): read it, or a failed terminal write
      // reads as a logged run.
      const { error: logError } = await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAt,
        p_rows_found: found,
        p_rows_written: sent,
        p_rows_skipped: skipped,
        p_ok: ok,
        p_error: errMsg,
        p_extra: { sent, skipped, skipped_incomplete: incomplete, guard_errors: guardErrors, bucket, min_abs_pct: minAbsPct, days, duration_ms: Date.now() - startedMs },
      });
      if (logError) console.log(`[${PIPELINE_NAME}] log err: ${logError.message}`);
    } catch (logErr) {
      console.log(`[${PIPELINE_NAME}] log err: ${logErr instanceof Error ? logErr.message : String(logErr)}`);
    }
  });

  return NextResponse.json({ ok: true, accepted: true, pipeline: PIPELINE_NAME, bucket }, { status: 202 });
}

// Dry-run variant of ensureUnsubToken that never writes: reports whether the
// recipient has opted out (unsubscribed, or weekly digest turned off).
async function ensureUnsubTokenPreview(email: string): Promise<"ok" | "unsubscribed" | "unverified"> {
  const { data, error } = await (supabaseAdmin as any)
    .from("email_subscribers")
    .select("unsubscribed_at, digest_weekly")
    .eq("email", email)
    .maybeSingle();
  // A failed read is not "not unsubscribed" — the live run skips it, so must the preview.
  if (error) return "unverified";
  return data?.unsubscribed_at || data?.digest_weekly === false ? "unsubscribed" : "ok";
}
