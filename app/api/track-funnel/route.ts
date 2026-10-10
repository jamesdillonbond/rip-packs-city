import { NextRequest, NextResponse } from "next/server";
import { anonTelemetryAllowed } from "@/lib/abuse/anon-rate";
import { createClient } from "@supabase/supabase-js";
import { safeApiError } from "@/lib/api-error"
import { isBotUserAgent } from "@/lib/bot-ua"

// Top-of-funnel event sink. Publicly reachable (see proxy.ts isPublicPath) so
// anon visitors on the marketing home, /share/<wallet>, and /insights can log
// arrivals + wallet-pastes. Inserts with the service-role key, which BYPASSES
// the funnel_events anon-INSERT RLS CHECK caps — so we replicate the table's
// event_type allowlist + length caps here defensively to keep a public
// endpoint from writing oversized/garbage rows. Limits mirror the DB exactly.

// Must match the funnel_events_event_type_check allowlist.
const ALLOWED_EVENT_TYPES = new Set([
  "home_view",
  "wallet_paste",
  "share_view",
  "share_cta_click",
  "insights_view",
  "insights_card_click",
  // Core product path: /[collection]/{overview,collection,market,sniper,sets,
  // analytics,play}. One type — the tab is carried in `surface` (the pathname),
  // so adding a tab needs no new event_type or CHECK change.
  "collection_view",
  // Public profile + its trophy-case sub-page (2026-09-12). Same one-type
  // shape as collection_view: the sub-page rides in `surface`, so a new
  // /profile sub-route needs no new event_type or CHECK change. This is where
  // every shared link lands, and it was the only page type in the product
  // firing nothing — 0 of 28,129 rows carried a profile surface.
  "profile_view",
  // Signup funnel (2026-07-20): a "create free account" CTA click, a successful
  // /auth/confirm session, and the deal-watch email capture on the analyzer.
  "signin_click",
  "account_created",
  "email_capture_submitted",
]);

type TrackFunnelBody = {
  eventType?: string | null;
  walletAddress?: string | null;
  surface?: string | null;
  referrer?: string | null;
  sessionId?: string | null;
  visitorId?: string | null;
};

// rpc_vid (lib/track-funnel.ts getVisitorId): a random UUID or the v_ fallback.
// Anything else is dropped rather than stored — this is a public endpoint.
const VISITOR_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
function visitorIdOrNull(v: unknown): string | null {
  return typeof v === "string" && VISITOR_ID_RE.test(v) ? v : null;
}

// Bot classification (deep-audit R23) lives in lib/bot-ua.ts — shared with the
// trophy funnel writer. Re-exported here because tests import it from the route.
export { isBotUserAgent }

function clampStr(v: unknown, max: number): string | null {
  if (v == null) return null;
  const s = String(v);
  if (!s) return null;
  return s.slice(0, max);
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as TrackFunnelBody;

    const eventType = clampStr(body.eventType, 64);
    if (!eventType || !ALLOWED_EVENT_TYPES.has(eventType)) {
      // Reject unknown event types quietly — never throw into a beacon caller.
      return NextResponse.json({ ok: false, error: "invalid event_type" }, { status: 200 });
    }

    // #180 item 4: every beacon spends a durable per-IP / global budget (this
    // route has no session lookup; 600/h per IP is far above a real visitor);
    // over it, the event is dropped silently.
    if (!(await anonTelemetryAllowed(req.headers, "track-funnel"))) {
      return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 200 });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // ⚠ Read the UA SERVER-SIDE. A client-supplied flag is worthless here —
    // the population we are trying to label is the one that would not send it.
    // ⚠ Optional-chained. A beacon caller is not guaranteed to carry headers —
    // and a route that throws while LOGGING an arrival turns a analytics gap into
    // a 500 for the visitor. A missing UA is UNKNOWN, which correctly classifies
    // as not-a-bot rather than guessing.
    const userAgent = clampStr(req.headers?.get("user-agent"), 512);

    const baseRow = {
      event_type: eventType,
      wallet_address: clampStr(body.walletAddress, 64),
      session_id: clampStr(body.sessionId, 64),
      surface: clampStr(body.surface, 80),
      referrer: clampStr(body.referrer, 512),
    };
    const row = {
      ...baseRow,
      user_agent: userAgent,
      bot_ua: isBotUserAgent(userAgent),
      visitor_id: visitorIdOrNull(body.visitorId),
    };

    // Await the insert — on Vercel the lambda is frozen as soon as the response
    // returns, so a non-awaited (.then) insert never flushes and the row is
    // silently dropped (this is why outbound_clicks went dead after 2026-04-25).
    // The client fires this via sendBeacon/keepalive and never waits on the
    // response, so awaiting a single fast insert costs the user nothing.
    let { error: insertError } = await supabase.from("funnel_events").insert(row);

    // ⚠ SELF-HEALING ORDERING, deliberately. This route shipped BEFORE the
    // migration adding `user_agent` and `bot_ua` existed in the database, so an
    // unknown column would have failed the insert and lost EVERY funnel row.
    //
    // The migration LANDED 2026-08-23 02:0xZ, so the fallback below is now
    // dormant — but it is kept, not deleted, because it is also the branch that
    // survives a rollback or a branch DB that has not caught up. ⚠ Do not
    // rewrite this comment to say "not applied yet"; that sentence was true for
    // about an hour and a stale ordering note is how the next person concludes
    // the columns are missing when they are not.
    if (insertError && /column|schema cache|PGRST204/i.test(insertError.message)) {
      const retry = await supabase.from("funnel_events").insert(baseRow);
      insertError = retry.error;
      if (!insertError) {
        console.log("[track-funnel] bot_ua columns absent from the schema cache; logged without them");
      }
    }
    if (insertError) console.error("[track-funnel] Supabase insert failed:", insertError.message);

    // `ok` is whether the row LANDED — a hardcoded true here published every
    // failed insert as a logged arrival. Status stays 200: a beacon never retries.
    return NextResponse.json(insertError ? { ok: false, error: "insert failed" } : { ok: true });
  } catch (e) {
    return NextResponse.json(
      // Shape-preserving: consumers branch on `ok`.
      { ok: false, ...safeApiError(e, "Funnel tracking failed.") },
      { status: 500 }
    );
  }
}
