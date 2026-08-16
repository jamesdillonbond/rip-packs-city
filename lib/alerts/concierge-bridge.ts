// lib/alerts/concierge-bridge.ts
//
// Item 8 (optional, phase 2): forward a non-command bot DM to the existing AI
// concierge (/api/support-chat) and return its reply text. Gated behind
// ALERTS_BOT_CONCIERGE="1" so the bots ship as command-only by default and the
// concierge is opt-in once the alert loop is stable.
//
// The support-chat route is public (proxy.ts isPublicPath) and self-contained,
// so we call it over HTTP with the bot-resolved ownerKey for personalization.

const SITE = "https://www.rippackscity.com";

/**
 * Hard bound on the call to /api/support-chat.
 *
 * ⚠ THIS FETCH HAD NO TIMEOUT, AND THAT IS WHAT LEFT A DISCORD USER STARING AT
 * "Rip Packs City is thinking…" FOR EIGHT MINUTES (2026-08-16).
 *
 * The bots defer the interaction and finish the work in `after()`, so the ONLY
 * thing that ever answers the user is the follow-up PATCH at the end of that
 * work. If the lambda is killed first, no follow-up is sent and Discord shows
 * its thinking state until the interaction token expires. The bot's own
 * try/catch cannot help: a killed lambda runs no catch block.
 *
 * `/api/support-chat` caps itself at maxDuration 60, so 70s covers every run it
 * can legitimately complete while still guaranteeing this call RETURNS —
 * failed, but returned — leaving the caller alive to send an honest message.
 * The bot routes carry a longer maxDuration than this so the PATCH always fits.
 */
const CONCIERGE_TIMEOUT_MS = 70_000;

export function conciergeEnabled(): boolean {
  return process.env.ALERTS_BOT_CONCIERGE === "1";
}

// Returns the concierge reply, or null if disabled / errored (caller falls back
// to a help message). sessionId namespaces the bot conversation so DMs don't
// collide with web sessions.
export async function conciergeReply(
  text: string,
  opts: { sessionId: string; ownerKey?: string | null; ownerId?: string | null }
): Promise<string | null> {
  if (!conciergeEnabled()) return null;
  try {
    const res = await fetch(`${SITE}/api/support-chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Trusted-bot header: lets support-chat accept the bridge-resolved
        // ownerKey (there's no auth cookie on a server-to-server call) and
        // rebuild DM conversation history server-side. Verified timing-safe
        // against INGEST_SECRET_TOKEN in the route.
        "x-rpc-bot-secret": process.env.INGEST_SECRET_TOKEN ?? "",
      },
      body: JSON.stringify({
        message: text.slice(0, 2000),
        sessionId: opts.sessionId,
        ownerKey: opts.ownerKey ?? undefined,
        // Auth uid from the verified channel link (resolve_channel_owner) —
        // lets alert-subscription tools act as the linked user over DM.
        ownerId: opts.ownerId ?? undefined,
        pageContext: "bot_dm",
      }),
      signal: AbortSignal.timeout(CONCIERGE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const reply = typeof data?.response === "string" ? data.response.trim() : "";
    return reply || null;
  } catch (e) {
    console.log("[alerts/concierge] bridge err", e instanceof Error ? e.message : String(e));
    return null;
  }
}
