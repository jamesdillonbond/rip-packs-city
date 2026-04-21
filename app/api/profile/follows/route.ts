// app/api/profile/follows/route.ts
//
// Phase 4 follows system. Users follow other RPC users by username.
//   GET    — list who the current user follows (+ usernames + bios)
//   POST   { username } — follow a user
//   DELETE { username } — unfollow

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";

async function resolveUserIdByUsername(username: string): Promise<string | null> {
  const { data } = await supabase
    .from("profile_bio")
    .select("user_id")
    .ilike("username", username)
    .maybeSingle();
  return (data as any)?.user_id ?? null;
}

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const { data: edges, error } = await supabase
    .from("follows")
    .select("followee_user_id, created_at")
    .eq("follower_user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[follows GET]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const followeeIds = (edges ?? []).map((e: any) => e.followee_user_id);
  if (followeeIds.length === 0) {
    return NextResponse.json({ follows: [] });
  }

  const { data: bios } = await supabase
    .from("profile_bio")
    .select("user_id, username, display_name, avatar_url, accent_color")
    .in("user_id", followeeIds);

  const bioMap = new Map<string, any>();
  (bios ?? []).forEach((b: any) => bioMap.set(b.user_id, b));

  const out = (edges ?? []).map((e: any) => ({
    user_id: e.followee_user_id,
    username: bioMap.get(e.followee_user_id)?.username ?? null,
    display_name: bioMap.get(e.followee_user_id)?.display_name ?? null,
    avatar_url: bioMap.get(e.followee_user_id)?.avatar_url ?? null,
    accent_color: bioMap.get(e.followee_user_id)?.accent_color ?? "#E03A2F",
    created_at: e.created_at,
  }));

  return NextResponse.json({ follows: out });
}

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const body = await req.json();
  const { username } = body;
  if (!username) {
    return NextResponse.json({ error: "username required" }, { status: 400 });
  }

  const followeeId = await resolveUserIdByUsername(String(username).toLowerCase());
  if (!followeeId) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  if (followeeId === user.id) {
    return NextResponse.json({ error: "Cannot follow yourself" }, { status: 400 });
  }

  const { error } = await supabase
    .from("follows")
    .upsert(
      { follower_user_id: user.id, followee_user_id: followeeId },
      { onConflict: "follower_user_id,followee_user_id" }
    );

  if (error) {
    console.error("[follows POST]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, followee_user_id: followeeId });
}

export async function DELETE(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const body = await req.json();
  const { username } = body;
  if (!username) {
    return NextResponse.json({ error: "username required" }, { status: 400 });
  }

  const followeeId = await resolveUserIdByUsername(String(username).toLowerCase());
  if (!followeeId) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { error } = await supabase
    .from("follows")
    .delete()
    .eq("follower_user_id", user.id)
    .eq("followee_user_id", followeeId);

  if (error) {
    console.error("[follows DELETE]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
