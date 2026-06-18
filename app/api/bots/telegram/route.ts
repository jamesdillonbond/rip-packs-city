// app/api/bots/telegram/route.ts
//
// Telegram bot webhook (webhook mode — no long-running process). PUBLIC in
// proxy.ts. Every update is authenticated by the secret-token header Telegram
// echoes back (set at registration time):
//   X-Telegram-Bot-Api-Secret-Token == TELEGRAM_WEBHOOK_SECRET
//
// Commands:
//   /start <code> | /link <code>  -> claim_channel_link('telegram', from.id, …)
//   /soldpacks [wallet]           -> pack report (wallet, or linked wallet)
//   /unlink                       -> remove this telegram channel
//   /help                         -> usage
//   (anything else)               -> concierge (if enabled) else help
//
// One-time webhook registration (run once with the real values):
//   https://api.telegram.org/bot<TELEGRAM_USER_BOT_TOKEN>/setWebhook
//     ?url=https://www.rippackscity.com/api/bots/telegram
//     &secret_token=<TELEGRAM_WEBHOOK_SECRET>

export const maxDuration = 30;
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { claimChannelLink, resolveChannelOwnerUsername } from "@/lib/alerts";
import {
  resolveWalletForChannel,
  getPackReport,
  formatPackReportText,
} from "@/lib/alerts/soldpacks";
import { conciergeReply, conciergeEnabled } from "@/lib/alerts/concierge-bridge";

const HELP =
  "Rip Packs City bot\n\n" +
  "/link <code> — connect this Telegram to your RPC account (get a code at rippackscity.com/alerts)\n" +
  "/soldpacks <wallet> — pack history + P/L for a Flow wallet\n" +
  "/unlink — stop alerts to this chat\n" +
  "/help — this message";

async function send(chatId: number | string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_USER_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  }).catch(() => {});
}

export async function POST(req: NextRequest) {
  // Authenticate via Telegram's echoed secret-token header.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true }); // ack malformed; never retry-storm
  }

  const msg = update?.message ?? update?.edited_message;
  const chatId: number | undefined = msg?.chat?.id;
  const fromId = msg?.from?.id != null ? String(msg.from.id) : null;
  const username: string | null = msg?.from?.username ?? null;
  const text: string = (msg?.text ?? "").trim();

  // Always 200 to Telegram quickly; do the work inline (cheap) but never throw.
  if (!chatId || !fromId || !text) return NextResponse.json({ ok: true });

  try {
    const [cmdRaw, ...rest] = text.split(/\s+/);
    const cmd = cmdRaw.toLowerCase().replace(/@.*$/, ""); // strip @botname suffix
    const arg = rest.join(" ").trim();

    if (cmd === "/start" || cmd === "/link") {
      if (!arg) {
        await send(chatId, "Send /link followed by the code from rippackscity.com/alerts. Example: /link AB12CD34");
        return NextResponse.json({ ok: true });
      }
      const result = await claimChannelLink("telegram", fromId, username, arg);
      await send(
        chatId,
        result?.ok
          ? "✅ Linked! You'll get your Rip Packs City alerts here. Manage them at rippackscity.com/alerts"
          : "That code is invalid or expired. Grab a fresh one at rippackscity.com/alerts"
      );
      return NextResponse.json({ ok: true });
    }

    if (cmd === "/unlink") {
      await supabase
        .from("notification_channels")
        .delete()
        .eq("channel", "telegram")
        .eq("channel_user_id", fromId);
      await send(chatId, "Unlinked. You won't get alerts here anymore. Re-link any time at rippackscity.com/alerts");
      return NextResponse.json({ ok: true });
    }

    if (cmd === "/soldpacks" || cmd === "/packs") {
      const wallet = await resolveWalletForChannel("telegram", fromId, arg || null);
      if (!wallet) {
        await send(
          chatId,
          arg
            ? "That doesn't look like a Flow wallet (0x + 16 hex). Try again: /soldpacks 0x…"
            : "Send a wallet: /soldpacks 0x… — or /link your account first and I'll use your saved wallet."
        );
        return NextResponse.json({ ok: true });
      }
      const report = await getPackReport(wallet);
      await send(chatId, formatPackReportText(report));
      return NextResponse.json({ ok: true });
    }

    if (cmd === "/help" || cmd === "/start") {
      await send(chatId, HELP);
      return NextResponse.json({ ok: true });
    }

    // Non-command: concierge (if enabled) else help. Pass the linked user's
    // Top Shot handle so the concierge can answer about their own collection;
    // unlinked users resolve to null and get today's generic behavior.
    if (conciergeEnabled() && !cmd.startsWith("/")) {
      const ownerKey = await resolveChannelOwnerUsername("telegram", fromId);
      const reply = await conciergeReply(text, { sessionId: `tg:${fromId}`, ownerKey });
      await send(chatId, reply ?? HELP);
      return NextResponse.json({ ok: true });
    }

    await send(chatId, HELP);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.log("[bots/telegram] err", e instanceof Error ? e.message : String(e));
    return NextResponse.json({ ok: true });
  }
}
