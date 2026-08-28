import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { safeApiError } from "@/lib/api-error"

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
};

// ── Bot classification (deep-audit R23) ─────────────────────────────────────
// MEASURED 7 days to 2026-08-22: 15,803 events across 15,689 distinct sessions.
// Only 53 sessions (0.34%) fired more than one event, and 99.82% carried a null
// referrer. `getSessionId()` persists `rpc_sess` in sessionStorage, so a real
// multi-page visit SHARES one id — 1.007 events/session is a crawler with fresh
// storage per fetch, not browsing. `collection_view` rose 82 -> 7,738/day
// between 08-16 and 08-18 with ZERO change in wallet_paste, signups or sign-ins.
//
// The table had no way to express any of that, so any future read of "views" as
// traction is wrong by roughly three orders of magnitude. Same shape as the
// `is_smoke_test` lesson — except here the flag did not exist yet.
//
// ⚠ THIS IS A HEURISTIC AND THE COLUMN NAME SAYS SO. `bot_ua` records what the
// USER-AGENT claims, nothing more: a crawler that lies is not caught, and a real
// browser is never flagged by it. It is a cheap FIRST cut whose job is to make
// the honest slice possible at all — the stronger signals (one-event sessions,
// null referrer) stay in the analysis, not in this column.
//
// ⚠ Slice by this BEFORE slicing by time. That is the whole lesson.
const BOT_UA = /bot|crawl|spider|slurp|bingpreview|headless|phantomjs|puppeteer|playwright|curl|wget|python-requests|httpx|axios|go-http-client|java\/|scrapy|facebookexternalhit|embedly|whatsapp|telegrambot|discordbot|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|claudebot|ccbot|perplexity|amazonbot|applebot|yandex|baiduspider|duckduckbot|lightpanda/i

/** True when the User-Agent SELF-IDENTIFIES as automated. Never a certainty. */
export function isBotUserAgent(ua: string | null | undefined): boolean {
  if (!ua) return false
  return BOT_UA.test(ua)
}

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
    const row = { ...baseRow, user_agent: userAgent, bot_ua: isBotUserAgent(userAgent) };

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

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      // Shape-preserving: consumers branch on `ok`.
      { ok: false, ...safeApiError(e, "Funnel tracking failed.") },
      { status: 500 }
    );
  }
}
