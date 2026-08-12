// app/api/profile/follows/route.ts
//
// Phase 4 follows system. Users follow other RPC users by username.
//   GET               — list who the current user follows (+ usernames + bios)
//   GET ?username=<u> — single-edge probe: { authed, following }
//   POST   { username } — follow a user
//   DELETE { username } — unfollow
//
// The `?username=` probe exists because the public profile page is ISR
// (revalidate 300, app/profile/[username]/page.tsx) — follow state is
// per-viewer so it can NOT be server-rendered, and the button has to ask on
// mount. It deliberately answers `{ authed: false }` instead of 401 for anon
// so the button can render a sign-in CTA rather than swallowing an error;
// this mirrors /api/teams/follow, whose GET has the same shape. The listing
// form (no query param) keeps its original requireUser() 401 contract.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { getCurrentUser, requireUser } from "@/lib/auth/supabase-server";
import { apiErrorResponse } from "@/lib/api-error";

async function resolveUserIdByUsername(username: string): Promise<string | null> {
  const { data } = await supabase
    .from("profile_bio")
    .select("user_id")
    .ilike("username", username)
    .maybeSingle();
  return (data as any)?.user_id ?? null;
}

export async function GET(req: NextRequest) {
  // Single-edge probe. Anon answers { authed: false } rather than 401 — the
  // caller is a button on an anon-readable page, not a data fetch.
  const probeUsername = req.nextUrl.searchParams.get("username");
  if (probeUsername) {
    const viewer = await getCurrentUser();
    if (!viewer) {
      return NextResponse.json(
        { authed: false, following: false },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    const followeeId = await resolveUserIdByUsername(probeUsername.toLowerCase());
    if (!followeeId) {
      return NextResponse.json(
        { authed: true, following: false, self: false },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    if (followeeId === viewer.id) {
      return NextResponse.json(
        { authed: true, following: false, self: true },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    const { data: edge, error: probeErr } = await supabase
      .from("follows")
      .select("followee_user_id")
      .eq("follower_user_id", viewer.id)
      .eq("followee_user_id", followeeId)
      .maybeSingle();

    if (probeErr) {
      console.error("[follows GET probe]", probeErr);
      return NextResponse.json({ error: "Could not read follow state" }, { status: 500 });
    }

    return NextResponse.json(
      { authed: true, following: !!edge, self: false },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

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
    return apiErrorResponse(error, "api/profile/follows");
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
    return apiErrorResponse(error, "api/profile/follows");
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
    return apiErrorResponse(error, "api/profile/follows");
  }
  return NextResponse.json({ ok: true });
}
