// app/api/profile/bio/route.ts
//
// Phase 4: auth.uid()-keyed profile bio. Username is the public URL handle;
// first save defaults it to the local-part of the user's email (lower-cased
// and stripped of non-alphanumerics). Users can override on their profile.

import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-error";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";
import { awardPoints } from "@/lib/rewards";

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

  // equipped_border/equipped_banner ride along so /profile/edit can PREVIEW the
  // profile as it will actually look. They are equipped from /rewards, a
  // different page, and without them the editor would render a preview missing
  // the cosmetics the collector spent Status on — a preview that quietly
  // disagrees with the page is worse than none.
  const { data, error } = await supabase
    .from("profile_bio")
    .select(
      "username, display_name, tagline, favorite_team, twitter, discord, avatar_url, accent_color, equipped_border, equipped_banner"
    )
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error("[profile/bio GET]", error);
    return apiErrorResponse(error, "api/profile/bio");
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

  // ⛔ MERGE, never REPLACE (2026-10-10). This used to upsert the WHOLE row with
  // every omitted field as null: /profile/edit never sends favoriteTeam, so each
  // save wiped the legacy favorite_team still shown on the public profile, and
  // the collection-profile avatar/bio editors (which send one or two fields)
  // would have nulled display name, socials and accent and rewritten the
  // username. An existing row now gets only the keys present in the body; the
  // email-derived username and the red accent are NEW-ROW defaults only.
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body ?? {}, k);
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  // A null/empty username means "not choosing one", never "clear my handle".
  if (typeof body.username === "string" && body.username) updates.username = body.username;
  if (has("displayName")) updates.display_name = body.displayName ?? null;
  if (has("bio") || has("tagline")) updates.tagline = body.bio ?? body.tagline ?? null;
  if (has("favoriteTeam")) updates.favorite_team = body.favoriteTeam ?? null;
  if (has("twitter")) updates.twitter = body.twitter ?? null;
  if (has("discord")) updates.discord = body.discord ?? null;
  if (has("avatarUrl")) updates.avatar_url = body.avatarUrl ?? null;
  if (has("accentColor")) updates.accent_color = body.accentColor ?? "#E03A2F";

  const SELECT = "username, display_name, tagline, favorite_team, twitter, discord, avatar_url, accent_color";
  const updateExisting = () =>
    supabase.from("profile_bio").update(updates).eq("user_id", user.id).select(SELECT).maybeSingle();

  let { data, error } = await updateExisting();
  if (!error && !data) {
    const ins = await supabase
      .from("profile_bio")
      .insert({
        user_id: user.id,
        username: defaultUsernameFromEmail(user.email) || null,
        accent_color: "#E03A2F",
        ...updates,
      })
      .select(SELECT)
      .maybeSingle();
    if (ins.error?.code === "23505") {
      // A concurrent save created the row first (user_id, or a username already
      // taken by the email default): merge into the user's row if it exists now.
      ({ data, error } = await updateExisting());
      if (!error && !data) error = ins.error;
    } else {
      data = ins.data;
      error = ins.error;
    }
  }

  if (error) {
    console.error("[profile/bio POST]", error);
    return apiErrorResponse(error, "api/profile/bio");
  }

  // Rewards: saving a profile earns complete_profile (per_user_limit=1, so only
  // the first save grants). user.id is session-resolved. Fire-and-forget.
  await awardPoints(user.id, "complete_profile");

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
    return apiErrorResponse(error, "api/profile/bio");
  }

  return NextResponse.json({ bio: data });
}
