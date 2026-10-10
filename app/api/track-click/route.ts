import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { safeApiError } from "@/lib/api-error"
import { getCurrentUser } from "@/lib/auth/supabase-server"
import { buildOutboundClickRow } from "@/lib/outbound-click-row"

type TrackClickBody = {
  surface?: string | null;
  destination?: string | null;
  collection?: string | null;
  linkKind?: string | null;
  editionKey?: string | null;
  momentId?: string | number | null;
  playerName?: string | null;
  setName?: string | null;
  tier?: string | null;
  serial?: number | null;
  askPrice?: number | null;
  fmv?: number | null;
  discount?: number | null;
  walletAddress?: string | null;
  sessionId?: string | null;
  buyUrl?: string | null;
  // legacy fields (kept for backward compat)
  label?: string | null;
  username?: string | null;
  rowRank?: number | null;
  compactMode?: boolean | null;
  sortKey?: string | null;
  sortDirection?: string | null;
  filters?: Record<string, unknown> | null;
  presetName?: string | null;
};

// This route is publicly reachable (see proxy.ts isPublicPath) so anon
// visitors on /insights + the marketing home can log outbound clicks. It
// inserts with the service-role key, which BYPASSES the anon_insert_outbound_
// clicks RLS CHECK caps — so the row builder (lib/outbound-click-row.ts)
// replicates those caps, and is shared with the alert redirect (/go/a/<id>).
//
// audit_20260930: the row now carries its COLLECTION, the signed-in user (from
// the session cookie the beacon sends — never from the body), the user agent and
// a bot flag, so public.attribute_outbound_clicks can match it to the marketplace
// sale that followed and say whether the buyer was the clicker's own wallet.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as TrackClickBody;

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const user = await getCurrentUser();
    // ⛔ The attribution fields are SERVER-SET (2026-10-10). The body used to be
    // spread AFTER `source: "site"`, so an anonymous POST could write
    // `source: "alert"` with any alertDeliveryId / channel and forge
    // alert-attributed clicks into attribute_outbound_clicks ("alerts drove
    // sales"). Alert clicks are recorded only by the /go/a redirect
    // (lib/alerts/tracked-redirect.ts); this beacon is always a site click.
    const row = buildOutboundClickRow({
      ...body,
      source: "site",
      alertDeliveryId: null,
      channel: null,
      userId: user?.id ?? null,
      userAgent: req.headers?.get?.("user-agent") ?? null,
    });

    // Await the insert — on Vercel the lambda freezes as soon as the response
    // returns, so a non-awaited (.then) insert never flushes and the row is
    // silently dropped (outbound_clicks went dead after 2026-04-25 for exactly
    // this reason). The client fires this via sendBeacon/keepalive and never
    // waits on the response, so awaiting one fast insert costs the user nothing.
    const { error: insertError } = await supabase.from("outbound_clicks").insert(row);
    if (insertError) {
      // ⚠ audit_20260930: this used to log and still answer { ok: true } — a
      // failed write reported as a recorded click. `ok` now means the row landed.
      console.error("[track-click] Supabase insert failed:", insertError.message);
      return NextResponse.json(
        { ok: false, ...safeApiError(insertError, "Click tracking failed.") },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      // Shape-preserving: consumers branch on `ok`.
      { ok: false, ...safeApiError(e, "Click tracking failed.") },
      { status: 500 }
    );
  }
}
