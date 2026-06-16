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

async function sendEmailGroup(to: string, group: Delivery[]): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY missing");
  const { subject, html, text } = buildEmailMessage(group);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "Rip Packs City <noreply@rippackscity.com>", to, subject, html, text }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function sendTelegramGroup(chatId: string, group: Delivery[]): Promise<void> {
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
  });
  if (!dmRes.ok) throw new Error(`discord dm ${dmRes.status}: ${(await dmRes.text()).slice(0, 200)}`);
  const dm = await dmRes.json();
  const msgRes = await fetch(`https://discord.com/api/v10/channels/${dm.id}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      content: `🎯 ${group.length} new alert${group.length === 1 ? "" : "s"} from Rip Packs City`,
      embeds: buildDiscordEmbeds(group),
    }),
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
