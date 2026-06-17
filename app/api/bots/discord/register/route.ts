// app/api/bots/discord/register/route.ts
//
// Server-side Discord slash-command registration. Registers the COMMANDS array
// GLOBALLY (with DM contexts) using the bot's own token from process.env, so
// /soldpacks, /link and /alerts work in DMs — not just inside the server.
//
// Why server-side: DISCORD_BOT_TOKEN is a SENSITIVE Vercel env var, so it can't
// be read back to curl from the dashboard. The runtime CAN read it (Sensitive
// only blocks dashboard/API reads, not process.env), so the server does the PUT
// with its own token. The raw token never leaves Vercel.
//
// Auth: Bearer INGEST_SECRET_TOKEN or CRON_SECRET (same as the cron routes).
// proxy.ts lets a Bearer-INGEST request through its token bypass, so this path
// is reachable even though it's not in isPublicPath.
//
// Trigger (once):
//   POST https://www.rippackscity.com/api/bots/discord/register?clear_guild=<guildId>
//   Header: Authorization: Bearer <INGEST_SECRET_TOKEN>
//
// Global commands take up to ~1h to appear in DMs; clear_guild removes the
// now-duplicate guild commands so they don't show twice once global propagates.

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { COMMANDS } from "@/lib/alerts/discord-commands";

function authed(req: NextRequest): boolean {
  const a = req.headers.get("authorization");
  return a === `Bearer ${process.env.INGEST_SECRET_TOKEN}` || a === `Bearer ${process.env.CRON_SECRET}`;
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ ok: false }, { status: 401 });

  const appId = process.env.DISCORD_APPLICATION_ID;
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!appId || !token) {
    return NextResponse.json({ ok: false, error: "missing discord env" }, { status: 500 });
  }

  const headers = {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "DiscordBot (https://www.rippackscity.com, 1.0)",
  };

  // Global registration — DM-capable via `contexts` on each command.
  const res = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
    method: "PUT",
    headers,
    body: JSON.stringify(COMMANDS),
  });
  const body = await res.json().catch(() => null);

  // Optional: clear the now-duplicate guild commands.
  const clearGuild = new URL(req.url).searchParams.get("clear_guild");
  let guildCleared: number | null = null;
  if (clearGuild) {
    const g = await fetch(`https://discord.com/api/v10/applications/${appId}/guilds/${clearGuild}/commands`, {
      method: "PUT",
      headers,
      body: "[]",
    });
    guildCleared = g.status;
  }

  // Never return the token; return names + statuses only.
  return NextResponse.json({
    ok: res.ok,
    status: res.status,
    registered: Array.isArray(body) ? body.map((c: any) => c.name) : body,
    guildCleared,
  });
}
