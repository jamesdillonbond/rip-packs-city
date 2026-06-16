// app/api/alerts/channels/route.ts
//
//   GET    -> this user's notification_channels (channel, verified, masked
//             target, username).
//   POST   -> start a link for { channel }. For email: create a code + send a
//             verification email to the account address. For telegram/discord:
//             create a code and return the bot deep links so the user can claim
//             it from the bot.
//   DELETE -> unlink ?channel= (scoped to owner_key).
//
// owner_key is ALWAYS the session user id.

export const maxDuration = 15;
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";
import { createChannelLinkCode, isChannel, type Channel } from "@/lib/alerts";

function maskTarget(channel: Channel, target: string | null): string | null {
  if (!target) return null;
  if (channel === "email") {
    const [user, domain] = target.split("@");
    if (!domain) return "•••";
    const head = user.slice(0, 2);
    return `${head}${"•".repeat(Math.max(1, user.length - 2))}@${domain}`;
  }
  // telegram chat_id / discord user id — show last 4
  return `••••${target.slice(-4)}`;
}

// Deep links the UI surfaces so the user can claim a telegram/discord link.
function botLinks(channel: Channel, code: string) {
  if (channel === "telegram") {
    const bot = process.env.TELEGRAM_USER_BOT_USERNAME; // e.g. "rippackscity_bot"
    return {
      deep_link: bot ? `https://t.me/${bot}?start=${encodeURIComponent(code)}` : null,
      instruction: bot
        ? `Open @${bot} on Telegram and it will link automatically, or send /link ${code}`
        : `Message the Rip Packs City bot on Telegram and send /link ${code}`,
    };
  }
  if (channel === "discord") {
    const appId = process.env.DISCORD_APPLICATION_ID;
    return {
      deep_link: appId
        ? `https://discord.com/oauth2/authorize?client_id=${appId}&scope=applications.commands%20bot&permissions=274877974528`
        : null,
      instruction: `Add the Rip Packs City bot to your server (or DM it) and run /link code:${code}`,
    };
  }
  return { deep_link: null, instruction: "" };
}

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const { data, error } = await supabase
    .from("notification_channels")
    .select("channel, channel_user_id, channel_username, verified, verified_at, last_used_at")
    .eq("owner_key", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const channels = (data ?? []).map((c: any) => ({
    channel: c.channel,
    verified: !!c.verified,
    username: c.channel_username,
    target: maskTarget(c.channel, c.channel_user_id),
    verified_at: c.verified_at,
    last_used_at: c.last_used_at,
  }));
  return NextResponse.json({ channels });
}

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const channel = body.channel;
  if (!isChannel(channel)) {
    return NextResponse.json({ error: "channel must be email | telegram | discord" }, { status: 400 });
  }

  // Email links bind to the account address (proves inbox ownership via the
  // verify link). Telegram/Discord bind on the bot side, so pass null here.
  const email = channel === "email" ? (user.email || "").trim().toLowerCase() : null;
  if (channel === "email" && !email) {
    return NextResponse.json({ error: "Your account has no email on file" }, { status: 400 });
  }

  const result = await createChannelLinkCode(user.id, channel, email);
  if (!result?.ok) {
    return NextResponse.json({ error: "Could not start the link" }, { status: 500 });
  }

  if (channel === "email") {
    const verifyUrl =
      `https://www.rippackscity.com/api/alerts/channels/verify-email` +
      `?code=${encodeURIComponent(result.code)}&email=${encodeURIComponent(email!)}`;
    await sendVerifyEmail(email!, verifyUrl).catch((e) =>
      console.log("[alerts/channels] verify email send err", e?.message)
    );
    return NextResponse.json({
      ok: true,
      channel,
      pending: true,
      message: `We sent a confirmation link to ${email}. Click it to start receiving alerts.`,
    });
  }

  // telegram / discord — hand back the code + bot deep links.
  return NextResponse.json({
    ok: true,
    channel,
    pending: true,
    code: result.code,
    expires_at: result.expires_at,
    ...botLinks(channel, result.code),
  });
}

export async function DELETE(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }
  const channel = req.nextUrl.searchParams.get("channel");
  if (!isChannel(channel)) {
    return NextResponse.json({ error: "channel must be email | telegram | discord" }, { status: 400 });
  }
  const { error } = await supabase
    .from("notification_channels")
    .delete()
    .eq("owner_key", user.id)
    .eq("channel", channel);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

async function sendVerifyEmail(to: string, verifyUrl: string) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log("[alerts/channels] RESEND_API_KEY missing — skipping verify email");
    return;
  }
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Rip Packs City <noreply@rippackscity.com>",
      to,
      subject: "Confirm email alerts — Rip Packs City",
      html: `
        <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0a0a0a;color:#fafafa;padding:32px;border-radius:14px;max-width:520px;margin:auto;">
          <div style="font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#e55a4c;font-weight:700;margin-bottom:10px;">Rip Packs City</div>
          <h2 style="margin:0 0 12px 0;">Confirm your alert emails</h2>
          <p style="color:rgba(255,255,255,0.65);line-height:1.55;">Click below to start receiving deal &amp; FMV alerts at this address.</p>
          <p style="margin:24px 0;"><a href="${verifyUrl}" style="display:inline-block;padding:13px 28px;background:#e55a4c;color:#0a0a0a;font-weight:800;text-decoration:none;border-radius:8px;">Confirm email alerts</a></p>
          <p style="color:rgba(255,255,255,0.45);font-size:12px;">If you didn't request this, you can ignore this email. This link expires in 15 minutes.</p>
        </div>`,
      text: `Confirm your Rip Packs City alert emails: ${verifyUrl}\n\nThis link expires in 15 minutes. If you didn't request it, ignore this email.`,
    }),
  });
}
