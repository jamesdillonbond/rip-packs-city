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

export function conciergeEnabled(): boolean {
  return process.env.ALERTS_BOT_CONCIERGE === "1";
}

// Returns the concierge reply, or null if disabled / errored (caller falls back
// to a help message). sessionId namespaces the bot conversation so DMs don't
// collide with web sessions.
export async function conciergeReply(
  text: string,
  opts: { sessionId: string; ownerKey?: string | null }
): Promise<string | null> {
  if (!conciergeEnabled()) return null;
  try {
    const res = await fetch(`${SITE}/api/support-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text.slice(0, 2000),
        sessionId: opts.sessionId,
        ownerKey: opts.ownerKey ?? undefined,
        pageContext: "bot_dm",
      }),
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
