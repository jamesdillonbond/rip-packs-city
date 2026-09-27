// lib/trophy/funnel-event.ts
//
// Server-side writer for the two trophy funnel events (2026-09-27, trophy-case
// campaign). Called by /api/profile/trophy AFTER the pin/unpin has landed, so a
// row here means the write happened — never an attempt.
//
// Why server-side and not the /api/track-funnel beacon: these rows carry
// `user_id`, and the funnel_events INSERT policy refuses any user_id and both
// trophy types from anon/authenticated. Only the service role writes them, so a
// beacon cannot claim a pin for somebody else.
//
// The session id + attribution come from the client (`getFunnelContext()` in
// lib/track-funnel.ts) so the row joins the same session as that visitor's
// beacons — that join is what ties a pin to a utm_campaign / share_ref.
//
// ⚠ A failure here must not fail the pin (the collector's action succeeded),
// and must not read as success either: it returns { ok:false, error } and logs.
// Milestones (started/completed) do NOT depend on this row — they are stamped by
// a trigger on trophy_moments — so a lost event loses attribution, not the count.

import { isBotUserAgent } from "@/lib/bot-ua";

export type TrophyFunnelEventType = "trophy_pinned" | "trophy_removed";

type Inserter = {
  from: (table: string) => { insert: (row: Record<string, unknown>) => PromiseLike<{ error: { message: string } | null }> };
};

function clampStr(v: unknown, max: number): string | null {
  if (v == null || typeof v !== "string" || v.length === 0) return null;
  return v.slice(0, max);
}

export async function logTrophyFunnelEvent(
  client: Inserter,
  args: {
    eventType: TrophyFunnelEventType;
    userId: string;
    slot: number;
    funnel?: unknown;
    userAgent?: string | null;
  }
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const f = (args.funnel && typeof args.funnel === "object" ? args.funnel : {}) as {
      sessionId?: unknown;
      referrer?: unknown;
    };
    const userAgent = clampStr(args.userAgent ?? null, 512);
    const { error } = await client.from("funnel_events").insert({
      event_type: args.eventType,
      user_id: args.userId,
      session_id: clampStr(f.sessionId, 64),
      referrer: clampStr(f.referrer, 512),
      surface: `trophy-case:slot-${args.slot}`,
      user_agent: userAgent,
      bot_ua: isBotUserAgent(userAgent),
    });
    if (error) {
      console.error(`[trophy funnel] ${args.eventType} insert failed:`, error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[trophy funnel] ${args.eventType} insert threw:`, message);
    return { ok: false, error: message };
  }
}
