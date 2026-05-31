import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type TrackClickBody = {
  surface?: string | null;
  destination?: string | null;
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
// clicks RLS CHECK caps — so we replicate those caps here defensively to keep
// a public endpoint from writing oversized/garbage rows. Limits mirror the
// DB policy exactly.
function clampStr(v: unknown, max: number): string | null {
  if (v == null) return null;
  const s = String(v);
  if (!s) return null;
  return s.slice(0, max);
}

function clampNum(v: unknown, min: number, max: number): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as TrackClickBody;

    // Fire-and-forget Supabase insert — never block the response
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const serial = clampNum(body.serial, 0, 10_000_000);
    const row = {
      surface: clampStr(body.surface, 64),
      destination: clampStr(body.destination, 256),
      edition_key: clampStr(body.editionKey, 64),
      moment_id: clampStr(body.momentId, 64),
      player_name: clampStr(body.playerName, 256),
      set_name: clampStr(body.setName, 256),
      tier: clampStr(body.tier, 32),
      serial: serial != null ? Math.round(serial) : null,
      ask_price_usd: clampNum(body.askPrice, 0, 10_000_000),
      fmv_usd: clampNum(body.fmv, 0, 10_000_000),
      discount_pct: clampNum(body.discount, -100, 100),
      wallet_address: clampStr(body.walletAddress, 32),
      session_id: clampStr(body.sessionId, 64),
      buy_url: clampStr(body.buyUrl, 4096),
    };

    // Await the insert — on Vercel the lambda freezes as soon as the response
    // returns, so a non-awaited (.then) insert never flushes and the row is
    // silently dropped (outbound_clicks went dead after 2026-04-25 for exactly
    // this reason). The client fires this via sendBeacon/keepalive and never
    // waits on the response, so awaiting one fast insert costs the user nothing.
    const { error: insertError } = await supabase.from("outbound_clicks").insert(row);
    if (insertError) console.error("[track-click] Supabase insert failed:", insertError.message);

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "track-click failed" },
      { status: 500 }
    );
  }
}