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

export async function PATCH(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if ("heroMomentId" in body) {
    updates.hero_moment_id = body.heroMomentId == null ? null : String(body.heroMomentId);
  }
  if ("heroMomentCollectionId" in body) {
    updates.hero_moment_collection_id =
      body.heroMomentCollectionId == null ? null : String(body.heroMomentCollectionId);
  }
  if (typeof body.displayName === "string") updates.display_name = body.displayName;
  if (typeof body.tagline === "string") updates.tagline = body.tagline;
  if (typeof body.favoriteTeam === "string") updates.favorite_team = body.favoriteTeam;
  if (typeof body.twitter === "string") updates.twitter = body.twitter;
  if (typeof body.discord === "string") updates.discord = body.discord;
  if (typeof body.avatarUrl === "string") updates.avatar_url = body.avatarUrl;
  if (typeof body.accentColor === "string") updates.accent_color = body.accentColor;
  if (typeof body.username === "string") updates.username = body.username;

  if (Object.keys(updates).length === 1) {
    return NextResponse.json({ error: "No updatable fields supplied" }, { status: 400 });
  }

  // Upsert because new users may not have a profile_bio row yet.
  const { data, error } = await supabase
    .from("profile_bio")
    .upsert(
      { user_id: user.id, ...updates },
      { onConflict: "user_id" }
    )
    .select(
      "username, display_name, tagline, favorite_team, twitter, discord, avatar_url, accent_color, hero_moment_id, hero_moment_collection_id"
    )
    .single();

  if (error) {
    console.error("[profile/bio PATCH]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ bio: data });
}
