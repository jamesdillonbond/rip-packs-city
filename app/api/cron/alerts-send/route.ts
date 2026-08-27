// app/api/cron/alerts-send/route.ts
//
// Per-channel sender. Claims pending alert_deliveries for a channel (atomic
// FOR UPDATE SKIP LOCKED -> 'sending'), groups them per recipient into ONE
// digest, sends it, then marks each row sent/failed. mark_delivery_failed
// re-queues to pending until attempts>=5.
//
//   GET/POST ?channel=email|telegram|discord  — one channel.
//   GET/POST (no channel)                      — loop all three.
//
// Auth: Bearer ${INGEST_SECRET_TOKEN} or ${CRON_SECRET}.
// Cron-job.org: every ~5 min, staggered off :00 and off alerts-dispatch.

export const maxDuration = 60;
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  claimPendingDeliveries,
  markDeliverySent,
  markDeliveryFailed,
  CHANNELS,
  type Channel,
  type Delivery,
} from "@/lib/alerts";
import { buildEmailMessage, buildTelegramMessage, buildDiscordEmbeds } from "@/lib/alerts/format";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any;

const PIPELINE_NAME = "alerts-send";

function authed(req: NextRequest): boolean {
  const auth = req.headers.get("authorization");
  return (
    auth === `Bearer ${process.env.INGEST_SECRET_TOKEN}` ||
    auth === `Bearer ${process.env.CRON_SECRET}`
  );
}

// Group a claimed batch by recipient (channel_user_id is the actual target and
// is 1:1 with owner for a given channel).
function groupByTarget(deliveries: Delivery[]): Map<string, Delivery[]> {
  const m = new Map<string, Delivery[]>();
  for (const d of deliveries) {
    const arr = m.get(d.channel_user_id) ?? [];
    arr.push(d);
    m.set(d.channel_user_id, arr);
  }
  return m;
}

// Per-request cap on every outbound DELIVERY call (Resend / Telegram / Discord).
//
// 🚨 WHY THIS ROUTE ESPECIALLY. `fetch()` has no default timeout, this dispatcher
// runs inside `after()` under `maxDuration = 60`, and its output is SILENCE — so
// a hung delivery call is the least falsifiable failure on the platform. CLAUDE.md
// names this the worst sub-class for exactly that reason: nobody notices alerts
// that were never sent.
//
// ⚠ AND THE DISTRIBUTION SAYS IT IS ALREADY HAPPENING, not that it might.
// Measured over 48h: 276 runs, avg 1,494 ms, **p95 1,644 ms** — and **max
// 58,670 ms against the 60,000 ms ceiling**. A route whose p95 is 1.6s does not
// take 58.7s for a normal reason; that outlier came within 1.3 SECONDS of a
// maxDuration kill, and a kill here writes no terminal row, so "no alerts sent"
// would be indistinguishable from "no alerts to send".
//
// 10s is generous for three transactional APIs that normally answer in ~1.5s.
//
// ⚠ An abort THROWS, which is the desired shape: `drainChannel` already wraps each
// recipient group in try/catch and counts it as a failed delivery, so one stuck
// recipient is recorded and the batch CONTINUES — instead of one stuck recipient
// silently costing every remaining recipient their alert.
const DELIVERY_TIMEOUT_MS = 10_000;

async function sendEmailGroup(to: string, group: Delivery[]): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY missing");
  const { subject, html, text } = buildEmailMessage(group);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "Rip Packs City <noreply@rippackscity.com>", to, subject, html, text }),
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function sendTelegramGroup(chatId: string, group: Delivery[]): Promise<void> {
  // Deliberately the USER-facing bot (TELEGRAM_USER_BOT_TOKEN), NOT the ops
  // sentinel bot (TELEGRAM_BOT_TOKEN). User deal-alerts go out over the same
  // bot users DM for the concierge (app/api/bots/telegram); the sentinel bot
  // is ops-only. Do NOT "unify" these — swapping to TELEGRAM_BOT_TOKEN would
  // deliver user alerts from the wrong bot (chat_ids won't match either).
  const token = process.env.TELEGRAM_USER_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_USER_BOT_TOKEN missing");
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: buildTelegramMessage(group),
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`telegram ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function sendDiscordGroup(userId: string, group: Delivery[]): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN missing");
  // Open (or fetch) a DM channel with the user, then post the embeds.
  const dmRes = await fetch("https://discord.com/api/v10/users/@me/channels", {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient_id: userId }),
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  if (!dmRes.ok) throw new Error(`discord dm ${dmRes.status}: ${(await dmRes.text()).slice(0, 200)}`);
  const dm = await dmRes.json();
  const msgRes = await fetch(`https://discord.com/api/v10/channels/${dm.id}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      // ⚠ The "/ask" line is not decoration — it is the only way a user can
      // reply here. This DM is the surface where they naturally type a
      // follow-up ("what's the cheapest one listed?"), and a plain message is
      // NEVER delivered to us: Discord sends message events over a Gateway
      // websocket, which serverless cannot hold, so only slash commands reach
      // the Interactions endpoint. Without this line the user types into the
      // void and concludes the bot is broken — which is exactly what happened.
      // Telegram needs no equivalent: its webhook does receive plain text.
      content:
        `🎯 ${group.length} new alert${group.length === 1 ? "" : "s"} from Rip Packs City\n` +
        `_Reply with_ \`/ask <question>\` _— plain messages don't reach the bot here._`,
      embeds: buildDiscordEmbeds(group),
    }),
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  if (!msgRes.ok) throw new Error(`discord msg ${msgRes.status}: ${(await msgRes.text()).slice(0, 200)}`);
}

async function drainChannel(channel: Channel): Promise<{ sent: number; failed: number }> {
  const claim = await claimPendingDeliveries(channel, 50);
  const deliveries = claim.deliveries ?? [];
  if (!deliveries.length) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;
  const groups = groupByTarget(deliveries);

  for (const [target, group] of groups) {
    try {
      if (channel === "email") await sendEmailGroup(target, group);
      else if (channel === "telegram") await sendTelegramGroup(target, group);
      else await sendDiscordGroup(target, group);
      for (const d of group) {
        await markDeliverySent(d.id);
        sent++;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[${PIPELINE_NAME}] ${channel} send err for ${target.slice(-6)}: ${msg}`);
      for (const d of group) {
        await markDeliveryFailed(d.id, msg);
        failed++;
      }
    }
  }
  return { sent, failed };
}

async function run(req: NextRequest) {
  if (!authed(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const channelParam = req.nextUrl.searchParams.get("channel");
  const channels: Channel[] =
    channelParam && (CHANNELS as string[]).includes(channelParam)
      ? [channelParam as Channel]
      : CHANNELS;

  const startedAt = new Date().toISOString();

  after(async () => {
    const startedMs = Date.now();
    let ok = true;
    let errMsg: string | null = null;
    let sent = 0;
    let failed = 0;

    for (const channel of channels) {
      try {
        const r = await drainChannel(channel);
        sent += r.sent;
        failed += r.failed;
      } catch (e) {
        ok = false;
        errMsg = `${errMsg ? errMsg + "; " : ""}${channel}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    // A non-zero failed count is not a pipeline failure (rows re-queue) — but
    // surface it in extra so the monitor can watch a stuck outbox.
    try {
      await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAt,
        p_rows_found: sent + failed,
        p_rows_written: sent,
        p_rows_skipped: failed,
        p_ok: ok,
        p_error: errMsg,
        p_extra: { sent, failed, channels, duration_ms: Date.now() - startedMs },
      });
    } catch (logErr) {
      console.log(`[${PIPELINE_NAME}] log err: ${logErr instanceof Error ? logErr.message : String(logErr)}`);
    }
  });

  return NextResponse.json({ ok: true, accepted: true, pipeline: PIPELINE_NAME, channels }, { status: 202 });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
