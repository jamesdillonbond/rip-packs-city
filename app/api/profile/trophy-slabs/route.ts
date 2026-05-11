// app/api/profile/trophy-slabs/route.ts
//
// Shared trophy-slab reader for both public profile pages and the auth-gated
// dashboard. Calls the get_trophy_slab_data{,_by_username} RPCs which already
// project the full enriched shape (acquired_price, play_description,
// collection_display_name, etc.) so the client only renders.
//
// Modes:
//   GET ?username=<u>  → public read via get_trophy_slab_data_by_username
//   GET ?mine=1         → owner read via get_trophy_slab_data(user.id)

import { NextRequest, NextResponse } from "next/server";
import { supabase as supabaseAnon, supabaseAdmin } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth/supabase-server";

export const dynamic = "force-dynamic";

type TrophySlabRow = {
  id: number;
  slot: number;
  moment_id: string;
  edition_id: string | null;
  player_name: string | null;
  set_name: string | null;
  serial_number: number | null;
  circulation_count: number | null;
  tier: string | null;
  thumbnail_url: string | null;
  video_url: string | null;
  fmv: number | null;
  badges: string[] | null;
  note: string | null;
  collection_id: string;
  collection_slug: string | null;
  collection_display_name: string | null;
  play_description: string | null;
  pinned_at: string | null;
  acquired_price: number | null;
  acquisition_method: string | null;
};

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const username = url.searchParams.get("username");
  const mine = url.searchParams.get("mine");

  if (!username && !mine) {
    return NextResponse.json(
      { error: "Provide ?username=<u> or ?mine=1" },
      { status: 400 }
    );
  }

  if (mine === "1") {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
    }
    // Service-role client — the RPC is SECDEF anyway, but using admin here
    // avoids needing a user-scoped server client for a read.
    const client: any = supabaseAdmin;
    const { data, error } = await client.rpc("get_trophy_slab_data", {
      p_user_id: user.id,
    });
    if (error) {
      console.error("[trophy-slabs mine]", error);
      return NextResponse.json({ slabs: [] });
    }
    return NextResponse.json({ slabs: normalize(data) });
  }

  // Public read — anonymous client so RLS/grants apply normally.
  const client: any = supabaseAnon;
  const { data, error } = await client.rpc(
    "get_trophy_slab_data_by_username",
    { p_username: username }
  );
  if (error) {
    console.error("[trophy-slabs public]", error);
    return NextResponse.json({ slabs: [] });
  }
  return NextResponse.json({ slabs: normalize(data) });
}

function normalize(data: unknown): TrophySlabRow[] {
  if (!Array.isArray(data)) return [];
  return data as TrophySlabRow[];
}
