// app/api/profile/bio/route.ts
//
// Phase 4: auth.uid()-keyed profile bio. Username is the public URL handle;
// first save defaults it to the local-part of the user's email (lower-cased
// and stripped of non-alphanumerics). Users can override on their profile.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";

function defaultUsernameFromEmail(email: string | null | undefined): string {
  if (!email) return "";
  return email.split("@")[0].toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const { data, error } = await supabase
    .from("profile_bio")
    .select("username, display_name, tagline, favorite_team, twitter, discord, avatar_url, accent_color")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error("[profile/bio GET]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ bio: data ?? null });
}

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const body = await req.json();
  const { username, displayName, tagline, bio, favoriteTeam, twitter, discord, avatarUrl, accentColor } = body;

  const resolvedUsername = (username ?? defaultUsernameFromEmail(user.email)) || null;

  const { data, error } = await supabase
    .from("profile_bio")
    .upsert(
      {
        user_id: user.id,
        username: resolvedUsername,
        display_name: displayName ?? null,
        tagline: bio ?? tagline ?? null,
        favorite_team: favoriteTeam ?? null,
        twitter: twitter ?? null,
        discord: discord ?? null,
        avatar_url: avatarUrl ?? null,
        accent_color: accentColor ?? "#E03A2F",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    )
    .select("username, display_name, tagline, favorite_team, twitter, discord, avatar_url, accent_color")
    .single();

  if (error) {
    console.error("[profile/bio POST]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ bio: data });
}
