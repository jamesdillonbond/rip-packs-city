// app/api/bots/discord/route.ts
//
// Discord Interactions endpoint (serverless; no gateway socket). PUBLIC in
// proxy.ts. Every request's Ed25519 signature is verified against
// DISCORD_PUBLIC_KEY before any work — Discord requires this and rejects the
// endpoint at registration if an invalid signature isn't 401'd.
//
// Slash commands (register once, see registerCommands() below):
//   /link code:<code>        -> claim_channel_link('discord', user.id, …)  (inline reply)
//   /soldpacks wallet:<addr> -> pack report (deferred; follow-up via webhook)
//   /alerts                  -> link to /alerts
//
// One-time command registration (run with real ids/token):
//   PUT https://discord.com/api/v10/applications/<DISCORD_APPLICATION_ID>/commands
//   Authorization: Bot <DISCORD_BOT_TOKEN>
//   body: see COMMANDS below.

export const maxDuration = 30;
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse, after } from "next/server";
import { verifyDiscordRequest } from "@/lib/alerts/discord-verify";
import { claimChannelLink } from "@/lib/alerts";
import {
  resolveWalletForChannel,
  getPackReport,
  formatPackReportDiscordEmbed,
} from "@/lib/alerts/soldpacks";

// Interaction types / response types.
const PING = 1;
const APPLICATION_COMMAND = 2;
const PONG = 1;
const CHANNEL_MESSAGE = 4;
const DEFERRED_MESSAGE = 5;
const EPHEMERAL = 64;

// Reference for the one-time registration call (kept beside the handler so the
// command schema lives with the code that handles it).
export const COMMANDS = [
  {
    name: "link",
    description: "Connect this Discord account to your Rip Packs City account",
    options: [{ name: "code", description: "The code from rippackscity.com/alerts", type: 3, required: true }],
  },
  {
    name: "soldpacks",
    description: "Pack history + P/L for a Flow wallet",
    options: [{ name: "wallet", description: "Flow wallet (0x… 16 hex)", type: 3, required: false }],
  },
  { name: "alerts", description: "Manage your Rip Packs City alerts" },
];

function ephemeral(content: string) {
  return NextResponse.json({ type: CHANNEL_MESSAGE, data: { content, flags: EPHEMERAL } });
}

function interactionUserId(body: any): string | null {
  return body?.member?.user?.id ?? body?.user?.id ?? null;
}

function optionValue(body: any, name: string): string | null {
  const opt = (body?.data?.options ?? []).find((o: any) => o.name === name);
  return opt?.value != null ? String(opt.value) : null;
}

async function followUp(applicationId: string, token: string, payload: any): Promise<void> {
  await fetch(
    `https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
  ).catch((e) => console.log("[bots/discord] followUp err", e?.message));
}

export async function POST(req: NextRequest) {
  const signature = req.headers.get("x-signature-ed25519") || "";
  const timestamp = req.headers.get("x-signature-timestamp") || "";
  const rawBody = await req.text(); // MUST read raw for verification before JSON.parse

  const valid = verifyDiscordRequest({
    publicKeyHex: process.env.DISCORD_PUBLIC_KEY || "",
    signatureHex: signature,
    timestamp,
    rawBody,
  });
  if (!valid) {
    return NextResponse.json({ error: "invalid request signature" }, { status: 401 });
  }

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }

  if (body.type === PING) {
    return NextResponse.json({ type: PONG });
  }

  if (body.type !== APPLICATION_COMMAND) {
    return NextResponse.json({ type: PONG });
  }

  const name: string = body?.data?.name ?? "";
  const userId = interactionUserId(body);

  if (name === "alerts") {
    return ephemeral("Manage your alerts at https://www.rippackscity.com/alerts");
  }

  if (name === "link") {
    const code = optionValue(body, "code");
    if (!userId || !code) return ephemeral("Usage: /link code:<your code from rippackscity.com/alerts>");
    const username = body?.member?.user?.username ?? body?.user?.username ?? null;
    const result = await claimChannelLink("discord", userId, username, code);
    return ephemeral(
      result?.ok
        ? "✅ Linked! Your Rip Packs City alerts will arrive here as DMs. Manage them at rippackscity.com/alerts"
        : "That code is invalid or expired. Grab a fresh one at rippackscity.com/alerts"
    );
  }

  if (name === "soldpacks") {
    if (!userId) return ephemeral("Couldn't read your Discord user id.");
    const walletArg = optionValue(body, "wallet");
    const appId = process.env.DISCORD_APPLICATION_ID || body.application_id;
    const token = body.token;

    // Defer (the pack RPCs are too slow for the 3s inline budget), then follow up.
    after(async () => {
      try {
        const wallet = await resolveWalletForChannel("discord", userId, walletArg);
        if (!wallet) {
          await followUp(appId, token, {
            content: walletArg
              ? "That doesn't look like a Flow wallet (0x + 16 hex)."
              : "Send a wallet: `/soldpacks wallet:0x…` — or `/link` your account first and I'll use your saved wallet.",
          });
          return;
        }
        const report = await getPackReport(wallet);
        await followUp(appId, token, { embeds: [formatPackReportDiscordEmbed(report)] });
      } catch (e) {
        console.log("[bots/discord] soldpacks err", e instanceof Error ? e.message : String(e));
        await followUp(appId, token, { content: "Couldn't load that pack report. Try again shortly." });
      }
    });

    return NextResponse.json({ type: DEFERRED_MESSAGE, data: { flags: EPHEMERAL } });
  }

  return ephemeral("Unknown command.");
}
