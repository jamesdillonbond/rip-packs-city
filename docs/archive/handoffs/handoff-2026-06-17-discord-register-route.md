# Handoff 2026-06-17 — Server-side Discord command registration (global + DM-enabled)

Plain text. Claude Code's direct file inspection wins over this doc.

## Why

The Discord slash commands were registered GUILD-scoped during setup (to dodge the transient `40333`), so they only work in the server, not DMs. To make `/soldpacks` (and `/link`, `/alerts`) work in DMs, they must be registered GLOBALLY with DM contexts. The manual curl path is dead: `DISCORD_BOT_TOKEN` is a SENSITIVE Vercel env var, so it can't be read back from the dashboard. The runtime CAN still read it (Sensitive only blocks dashboard/API reads, not `process.env`), so let the server do the registration with its own token. No raw-token handling, no rotation — and it makes re-registering commands a one-liner forever.

## Add a route: app/api/bots/discord/register/route.ts

Auth: Bearer `INGEST_SECRET_TOKEN` (and/or `CRON_SECRET`) — same check as the cron routes. Reads `DISCORD_BOT_TOKEN` + `DISCORD_APPLICATION_ID` from env. PUTs the commands GLOBALLY. Sketch:

export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { COMMANDS } from "@/lib/.../discord-commands";  // see step below

function authed(req: NextRequest) {
  const a = req.headers.get("authorization");
  return a === `Bearer ${process.env.INGEST_SECRET_TOKEN}` || a === `Bearer ${process.env.CRON_SECRET}`;
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ ok:false }, { status: 401 });
  const appId = process.env.DISCORD_APPLICATION_ID;
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!appId || !token) return NextResponse.json({ ok:false, error:"missing discord env" }, { status: 500 });

  const headers = { "Authorization": `Bot ${token}`, "Content-Type": "application/json",
                    "User-Agent": "DiscordBot (https://www.rippackscity.com, 1.0)" };

  // global registration (DM-capable via contexts on each command)
  const res = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`,
    { method: "PUT", headers, body: JSON.stringify(COMMANDS) });
  const body = await res.json().catch(() => null);

  // optional: clear the now-duplicate guild commands
  const clearGuild = new URL(req.url).searchParams.get("clear_guild");
  let guildCleared = null;
  if (clearGuild) {
    const g = await fetch(`https://discord.com/api/v10/applications/${appId}/guilds/${clearGuild}/commands`,
      { method: "PUT", headers, body: "[]" });
    guildCleared = g.status;
  }

  // never return the token; return names + statuses only
  return NextResponse.json({
    ok: res.ok, status: res.status,
    registered: Array.isArray(body) ? body.map((c:any)=>c.name) : body,
    guildCleared,
  });
}

## Make COMMANDS DM-capable (single source of truth)

The `COMMANDS` array currently lives in app/api/bots/discord/route.ts and has NO `contexts`. Move it to a shared module (e.g. lib/alerts/discord-commands.ts) imported by both the interactions route and this register route, and add `contexts: [0,1,2]` to each command (0=GUILD, 1=BOT_DM, 2=PRIVATE_CHANNEL). That's what enables DM usage. (Leave `integration_types` unset — default guild-install is correct; Trevor shares a server with the bot, so BOT_DM context resolves.)

## Trigger (Trevor, once)

POST https://www.rippackscity.com/api/bots/discord/register?clear_guild=657618722634203176
Header: Authorization: Bearer <INGEST_SECRET_TOKEN>   (the same token used for the alerts-send tests)

A 200 with `registered: ["link","soldpacks","alerts"]` = done. The raw bot token never leaves Vercel.

## Notes

- Global commands take up to ~1 hour to appear in DMs (guild commands were instant). The `clear_guild` arg removes the server duplicates so commands don't show twice once global propagates.
- The bot interactions route ALREADY handles DM interactions (`body?.member?.user?.id ?? body?.user?.id`), so no other code change is needed.
- proxy.ts: a Bearer-INGEST request passes the proxy's token bypass first, so `/api/bots/discord/register` is reachable even though it's not in `isPublicPath`. (Alternatively place the route under `/api/admin/*`, already public-bypassed + internally token-gated.)
- Never log or return `DISCORD_BOT_TOKEN`.

## Revert

Delete the route. (Moving COMMANDS to a shared module is harmless to keep.)
