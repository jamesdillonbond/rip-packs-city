import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

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
]);

type TrackFunnelBody = {
  eventType?: string | null;
  walletAddress?: string | null;
  surface?: string | null;
  referrer?: string | null;
  sessionId?: string | null;
};

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

    const row = {
      event_type: eventType,
      wallet_address: clampStr(body.walletAddress, 64),
      session_id: clampStr(body.sessionId, 64),
      surface: clampStr(body.surface, 80),
      referrer: clampStr(body.referrer, 512),
    };

    // Non-blocking — don't await, return 200 immediately.
    supabase
      .from("funnel_events")
      .insert(row)
      .then(({ error }) => {
        if (error) console.error("[track-funnel] Supabase insert failed:", error.message);
      });

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "track-funnel failed" },
      { status: 500 }
    );
  }
}
