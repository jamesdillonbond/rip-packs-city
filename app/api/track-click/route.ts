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

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as TrackClickBody;

    // Fire-and-forget Supabase insert — never block the response
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const row = {
      surface: body.surface ?? null,
      destination: body.destination ?? null,
      edition_key: body.editionKey ?? null,
      moment_id: body.momentId != null ? String(body.momentId) : null,
      player_name: body.playerName ?? null,
      set_name: body.setName ?? null,
      tier: body.tier ?? null,
      serial: body.serial ?? null,
      ask_price_usd: body.askPrice ?? null,
      fmv_usd: body.fmv ?? null,
      discount_pct: body.discount ?? null,
      wallet_address: body.walletAddress ?? null,
      session_id: body.sessionId ?? null,
      buy_url: body.buyUrl ?? null,
    };

    // Non-blocking — don't await, return 200 immediately
    supabase
      .from("outbound_clicks")
      .insert(row)
      .then(({ error }) => {
        if (error) console.error("[track-click] Supabase insert failed:", error.message);
      });

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "track-click failed" },
      { status: 500 }
    );
  }
}