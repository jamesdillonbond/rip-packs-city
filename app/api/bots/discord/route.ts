// app/api/bots/discord/route.ts
//
// Discord Interactions endpoint (serverless; no gateway socket). PUBLIC in
// proxy.ts. Every request's Ed25519 signature is verified against
// DISCORD_PUBLIC_KEY before any work — Discord requires this and rejects the
// endpoint at registration if an invalid signature isn't 401'd.
//
// Slash commands. The canonical schema is COMMANDS in
// lib/alerts/discord-commands.ts; this list must name every one of them, which
// __tests__/discord-commands.test.ts pins — it went stale once, omitting /ask
// while the timeout note below discussed /ask at length:
//   /link code:<code>        -> claim_channel_link('discord', user.id, …)  (inline reply)
//   /soldpacks wallet:<addr> -> pack report            (deferred; follow-up via webhook)
//   /alerts                  -> link to /alerts                            (inline reply)
//   /ask question:<text>     -> concierge answer       (deferred; follow-up via webhook)
//
// ⚠ A command in COMMANDS DOES NOTHING until it is REGISTERED with Discord —
// it is absent from every user's client, which is INDISTINGUISHABLE FROM A DEAD
// BOT. Registration is POST /api/bots/discord/register (there is no
// registerCommands() in this file; that reference was dangling). GET on that
// same route reports registered / missing / dm_capable using the server's own
// bot token, so the token never leaves Vercel — run it before concluding the
// bot is broken.
//
// ⚠ A plain Discord DM reaches NOTHING here. This is an Interactions webhook:
// Discord sends it PING and APPLICATION_COMMAND only. Ordinary DM messages are
// Gateway events (MESSAGE_CREATE, privileged MESSAGE_CONTENT intent) over a
// persistent socket serverless cannot hold, so /ask is the only concierge path
// on Discord and no change to this repo can alter that.

// ⚠ THIS MUST OUTLIVE /api/support-chat, WHICH CAPS ITSELF AT 60s.
//
// It was 60 — the SAME budget as the route it calls — so when the concierge ran
// long, this lambda was killed at the very moment its own error handling would
// have fired. `/ask` is DEFERRED, so the only thing that ever answers the user
// is the follow-up PATCH at the end of `after()`; a killed lambda sends none,
// and Discord shows "Rip Packs City is thinking…" until the interaction token
// expires. Measured 2026-08-16: a user sat on that for eight minutes, and the
// log line was `POST /api/bots/discord 200 [error] Task timed out after 60
// seconds`. A caller that dies with its callee has no failure path at all.
//
// 90s = the callee's own 60s ceiling + the bridge's 70s abort + room for the
// PATCH. Raise the bridge timeout and this together, never one alone.
export const maxDuration = 90;
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse, after } from "next/server";
import { verifyDiscordRequest } from "@/lib/alerts/discord-verify";
import { claimChannelLink, resolveChannelOwner, resolveChannelOwnerUsername } from "@/lib/alerts";
import { conciergeReply, conciergeEnabled } from "@/lib/alerts/concierge-bridge";
import {
  resolveWalletForChannel,
  getPackReport,
  formatPackReportDiscordEmbed,
} from "@/lib/alerts/soldpacks";
import { COMMANDS } from "@/lib/alerts/discord-commands";

// Re-exported for backward compat with any caller that imported COMMANDS from
// this route; the canonical definition lives in lib/alerts/discord-commands.ts.
export { COMMANDS };

// Interaction types / response types.
const PING = 1;
const APPLICATION_COMMAND = 2;
const PONG = 1;
const CHANNEL_MESSAGE = 4;
const DEFERRED_MESSAGE = 5;
const EPHEMERAL = 64;

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
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // 10s cap. `fetch()` has NO default timeout and this runs inside `after()`
      // under maxDuration 90 — a kill there runs neither the success path nor
      // the `.catch()` below, so a hung Discord would leave the user's slash
      // command showing "thinking…" forever with nothing logged anywhere.
      //
      // ⭐ Not a fresh guess: the bound already measured and shipped for these
      // same transactional APIs in app/api/cron/alerts-send/route.ts (276 runs
      // over 48h, avg 1,494 ms, p95 1,644 ms).
      //
      // ⚠ An abort rejects, so the existing `.catch()` records it — a failed
      // follow-up becomes a log line instead of a silent lambda kill.
      signal: AbortSignal.timeout(10_000),
    }
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

  if (name === "ask") {
    const question = (optionValue(body, "question") ?? "").trim();
    if (!userId || !question) return ephemeral("Usage: `/ask question:<anything>`");
    if (!conciergeEnabled()) {
      return ephemeral("The concierge isn't switched on yet — manage alerts at https://www.rippackscity.com/alerts");
    }
    const appId = process.env.DISCORD_APPLICATION_ID || body.application_id;
    const token = body.token;

    // Defer (concierge tool loops blow the 3s inline budget), then follow up.
    // sessionId dc:<userId> is stable per user, so support-chat rebuilds the
    // DM thread's history server-side — /ask is a running conversation.
    after(async () => {
      try {
        const ownerKey = await resolveChannelOwnerUsername("discord", userId);
        const owner = await resolveChannelOwner("discord", userId);
        const ownerId = owner.linked ? owner.owner_key ?? null : null;
        const reply = await conciergeReply(question, { sessionId: `dc:${userId}`, ownerKey, ownerId });
        const content = reply
          ? reply.length > 1990
            ? reply.slice(0, 1990).trimEnd() + "…" // Discord 2000-char cap
            : reply
          : "Couldn't get an answer just now — try again in a moment.";
        // ⚠ Reaching this line at all is the point: a deferred interaction that
        // never gets a follow-up shows "thinking…" until the token expires.
        await followUp(appId, token, { content });
      } catch (e) {
        console.log("[bots/discord] ask err", e instanceof Error ? e.message : String(e));
        await followUp(appId, token, { content: "Couldn't get an answer just now — try again in a moment." });
      }
    });

    return NextResponse.json({ type: DEFERRED_MESSAGE, data: { flags: EPHEMERAL } });
  }

  return ephemeral("Unknown command.");
}
