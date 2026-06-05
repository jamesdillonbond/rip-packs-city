// app/api/public/profile/[username]/route.ts
//
// Public profile endpoint — NO auth required. Returns a bundle of trophy
// moments + bio + privacy-stripped saved-wallet summaries for the given
// username, suitable for the shareable /profile/[username] page.
//
// Path sits under /api/public/* which the proxy doesn't gate.
//
// Lookup pattern: username (URL path param) -> user_id (resolved via the
// denormalized `profile_bio.username` cache) -> profile_bio.user_id (full
// row) -> trophies / saved_wallets (keyed on user_id, the only canonical
// foreign key into auth.users). Never join trophies / saved_wallets to
// profile_bio.username directly — that column is a cache, the source of
// truth is auth.users.id.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ username: string }> }
) {
  const startedAt = Date.now();
  const { username } = await params;
  const handle = (username || "").trim().toLowerCase();
  console.log(`[public/profile] start username=${handle}`);
  if (!handle) {
    return NextResponse.json({ error: "username required" }, { status: 400 });
  }

  // Step 1: username -> user_id. profile_bio.username is the denormalized
  // cache that maps the public URL handle to auth.users.id; we read just
  // user_id here so the rest of the pipeline keys on the canonical id.
  const resolveT0 = Date.now();
  const { data: idRow, error: idErr } = await supabase
    .from("profile_bio")
    .select("user_id")
    .ilike("username", handle)
    .maybeSingle();
  console.log(`[public/profile] resolve username->user_id elapsedMs=${Date.now() - resolveT0} found=${!!idRow}`);

  if (idErr) {
    console.error("[public/profile resolve]", idErr);
    return NextResponse.json({ error: idErr.message }, { status: 500 });
  }
  if (!idRow) {
    console.log(`[public/profile] not_found elapsedMs=${Date.now() - startedAt}`);
    return NextResponse.json({ error: "Not found", username: handle }, { status: 404 });
  }

  const userId = (idRow as any).user_id as string;

  // Step 2: load full bio + trophies + wallets in parallel, all keyed on
  // user_id. The bio row is the same one we just probed; we re-select with
  // the full column set so the response is a single round-trip away from a
  // ready-to-render payload.
  const fanT0 = Date.now();
  const [{ data: bio, error: bioErr }, { data: trophies }, { data: wallets }] = await Promise.all([
    supabase
      .from("profile_bio")
      .select("username, display_name, tagline, favorite_team, twitter, discord, avatar_url, accent_color, equipped_border, equipped_banner")
      .eq("user_id", userId)
      .maybeSingle(),
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

  if (bioErr) {
    console.error("[public/profile bio]", bioErr);
    return NextResponse.json({ error: bioErr.message }, { status: 500 });
  }
  if (!bio) {
    console.log(`[public/profile] bio_missing_for_user_id elapsedMs=${Date.now() - startedAt}`);
    return NextResponse.json({ error: "Not found", username: handle }, { status: 404 });
  }
  console.log(`[public/profile] trophies+wallets parallel elapsedMs=${Date.now() - fanT0} trophies=${trophies?.length ?? 0} wallets=${wallets?.length ?? 0}`);

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

  console.log(`[public/profile] done elapsedMs=${Date.now() - startedAt}`);
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
      equipped_border: (bio as { equipped_border?: string | null }).equipped_border ?? null,
      equipped_banner: (bio as { equipped_banner?: string | null }).equipped_banner ?? null,
    },
    trophies: trophies ?? [],
    wallets: walletSummaries,
  });
}
