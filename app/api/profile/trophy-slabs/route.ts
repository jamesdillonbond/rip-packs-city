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
//
// ⚠ A FAILED READ IS NOT AN EMPTY TROPHY CASE (fixed 2026-08-13). Both legs
// used to swallow the RPC error into `{ slabs: [] }` at HTTP 200 — byte-
// identical to a collector who has pinned nothing. Since /profile/<username>
// renders an empty list as "No trophies pinned yet.", a momentary DB blip told
// every visitor that a collector with a full case had an empty one: a claim
// about that person, manufactured from our own outage, on the page they share.
// The owner leg was worse — a dashboard showing six empty slots invites the
// owner to re-pin trophies that were never gone.
//
// Now classified through `apiErrorResponse`, so a statement timeout is a
// retryable 503 rather than a 200, no driver text reaches the body, and the
// response is `no-store`. Callers must branch on `res.ok`; an empty `slabs`
// array now means exactly one thing.

import { NextRequest, NextResponse } from "next/server";
import { supabase as supabaseAnon, supabaseAdmin } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth/supabase-server";
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";

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
  fmv_confidence: string | null;
  badges: string[] | null;
  note: string | null;
  collection_id: string;
  collection_slug: string | null;
  collection_display_name: string | null;
  play_description: string | null;
  team_name: string | null;
  series: number | null;
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
    const { data, error } = await boundedRead(client.rpc("get_trophy_slab_data", {
      p_user_id: user.id,
    }), "api/profile/trophy-slabs/get_trophy_slab_data");
    if (error) {
      console.error("[trophy-slabs mine]", error);
      return apiErrorResponse(error, "api/profile/trophy-slabs");
    }
    return NextResponse.json({ slabs: normalize(data) });
  }

  // Public read — anonymous client so RLS/grants apply normally.
  const client: any = supabaseAnon;
  const { data, error } = await boundedRead(client.rpc(
    "get_trophy_slab_data_by_username",
    { p_username: username }
  ), "api/profile/trophy-slabs/get_trophy_slab_data_by_username");
  if (error) {
    console.error("[trophy-slabs public]", error);
    return apiErrorResponse(error, "api/profile/trophy-slabs");
  }
  return NextResponse.json({ slabs: normalize(data) });
}

function normalize(data: unknown): TrophySlabRow[] {
  if (!Array.isArray(data)) return [];
  return data as TrophySlabRow[];
}
