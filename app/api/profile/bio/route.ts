import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

// GET ?ownerKey=xxx
export async function GET(req: NextRequest) {
  const ownerKey = req.nextUrl.searchParams.get("ownerKey");
  if (!ownerKey) return NextResponse.json({ error: "ownerKey required" }, { status: 400 });

  const { data, error } = await supabase
    .from("profile_bio")
    .select("display_name, tagline, favorite_team, twitter, discord, avatar_url")
    .eq("owner_key", ownerKey)
    .maybeSingle();

  if (error) {
    console.error("[profile/bio GET]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ bio: data ?? null });
}

// POST { ownerKey, displayName, tagline, bio, favoriteTeam, twitter, discord, avatarUrl }
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { ownerKey, displayName, tagline, bio, favoriteTeam, twitter, discord, avatarUrl } = body;

  if (!ownerKey) return NextResponse.json({ error: "ownerKey required" }, { status: 400 });

  const { data, error } = await supabase
    .from("profile_bio")
    .upsert({
      owner_key: ownerKey,
      display_name: displayName ?? null,
      tagline: bio ?? tagline ?? null,
      favorite_team: favoriteTeam ?? null,
      twitter: twitter ?? null,
      discord: discord ?? null,
      avatar_url: avatarUrl ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "owner_key" })
    .select("display_name, tagline, favorite_team, twitter, discord, avatar_url")
    .single();

  if (error) {
    console.error("[profile/bio POST]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ bio: data });
}