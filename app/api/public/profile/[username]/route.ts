// app/api/public/profile/[username]/route.ts
//
// Public profile endpoint — NO auth required. Returns a bundle of trophy
// moments + bio + privacy-stripped saved-wallet summaries for the given
// username, suitable for the shareable /profile/[username] page.
//
// Path sits under /api/public/* which the proxy doesn't gate.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ username: string }> }
) {
  const { username } = await params;
  const handle = (username || "").trim().toLowerCase();
  if (!handle) {
    return NextResponse.json({ error: "username required" }, { status: 400 });
  }

  // Resolve username -> user_id via profile_bio
  const { data: bio, error: bioErr } = await supabase
    .from("profile_bio")
    .select("user_id, username, display_name, tagline, favorite_team, twitter, discord, avatar_url, accent_color")
    .ilike("username", handle)
    .maybeSingle();

  if (bioErr) {
    console.error("[public/profile bio]", bioErr);
    return NextResponse.json({ error: bioErr.message }, { status: 500 });
  }
  if (!bio) {
    return NextResponse.json({ error: "Not found", username: handle }, { status: 404 });
  }

  const userId = (bio as any).user_id;

  const [{ data: trophies }, { data: wallets }] = await Promise.all([
    supabase
      .from("trophy_moments")
      .select("slot, moment_id, collection_id, edition_id, player_name, set_name, serial_number, circulation_count, tier, thumbnail_url, video_url, fmv, badges, note, pinned_at")
      .eq("user_id", userId)
      .order("slot", { ascending: true }),
    supabase
      .from("saved_wallets")
      .select("username, display_name, collection_id, cached_fmv_usd, cached_moment_count, cached_top_tier, cached_badges, accent_color, cached_rpc_score, cached_change_24h")
      .eq("user_id", userId),
  ]);

  // Strip wallet addresses from the public payload
  const walletSummaries = (wallets ?? []).map((w: any) => ({
    username: w.username ?? null,
    display_name: w.display_name ?? null,
    collection_id: w.collection_id,
    cached_fmv: w.cached_fmv_usd ?? null,
    cached_moment_count: w.cached_moment_count ?? null,
    cached_top_tier: w.cached_top_tier ?? null,
    cached_badges: w.cached_badges ?? null,
    accent_color: w.accent_color ?? "#E03A2F",
    cached_rpc_score: w.cached_rpc_score ?? null,
    cached_change_24h: w.cached_change_24h ?? null,
  }));

  return NextResponse.json({
    username: bio.username,
    bio: {
      display_name: bio.display_name,
      tagline: bio.tagline,
      favorite_team: bio.favorite_team,
      twitter: bio.twitter,
      discord: bio.discord,
      avatar_url: bio.avatar_url,
      accent_color: bio.accent_color,
    },
    trophies: trophies ?? [],
    wallets: walletSummaries,
  });
}
