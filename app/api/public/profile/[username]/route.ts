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
  // Trophies resolve through get_trophy_slab_data_by_username — the SAME live
  // RPC the owner dashboard + public page (/api/profile/trophy-slabs) use — so
  // anon visitors / OG unfurls see LIVE tier + fmv, not the pin-time values
  // frozen in trophy_moments (which carry null tiers + stale prices). We map
  // back to this endpoint's existing field set and intentionally DROP the RPC's
  // acquired_price / acquisition_method so the public payload never leaks owner
  // cost basis / P/L. (fix 2026-06-15)
  const [{ data: bio, error: bioErr }, { data: trophyData }, { data: wallets }] = await Promise.all([
    supabase
      .from("profile_bio")
      .select("username, display_name, tagline, favorite_team, twitter, discord, avatar_url, accent_color, equipped_border, equipped_banner")
      .eq("user_id", userId)
      .maybeSingle(),
    supabase.rpc("get_trophy_slab_data_by_username", { p_username: handle }),
    supabase
      .from("saved_wallets")
      .select("username, display_name, collection_id, cached_fmv_usd, cached_moment_count, cached_top_tier, cached_badges, accent_color, cached_rpc_score, cached_change_24h")
      .eq("user_id", userId),
  ]);

  // jsonb array out of the RPC → original public-trophy shape, live values,
  // numerics coerced back from jsonb strings. No cost-basis fields.
  const trophies = (Array.isArray(trophyData) ? trophyData : []).map((t: any) => ({
    slot: t.slot != null ? Number(t.slot) : null,
    moment_id: t.moment_id ?? null,
    collection_id: t.collection_id ?? null,
    edition_id: t.edition_id ?? null,
    player_name: t.player_name ?? null,
    set_name: t.set_name ?? null,
    serial_number: t.serial_number != null ? Number(t.serial_number) : null,
    circulation_count: t.circulation_count != null ? Number(t.circulation_count) : null,
    tier: t.tier ?? null,
    thumbnail_url: t.thumbnail_url ?? null,
    video_url: t.video_url ?? null,
    fmv: t.fmv != null ? Number(t.fmv) : null,
    fmv_confidence: t.fmv_confidence ?? null,
    badges: t.badges ?? null,
    note: t.note ?? null,
    pinned_at: t.pinned_at ?? null,
  }));

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
