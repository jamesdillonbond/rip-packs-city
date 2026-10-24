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

// THREE outcomes, never two (2026-10-23): until then a failed read returned
// null, so the probe answered "not following", and POST/DELETE answered
// "User not found" 404 for a user who exists.
//
// `ilike` is a PATTERN: `_` and `%` in a username are wildcards, so "a_b" also
// matched "axb" (and two such rows made maybeSingle error). The pattern is
// escaped to a literal and the returned name re-compared exactly, as
// lib/auth/owner-key-guard.ts does.
type Resolved = { ok: true; userId: string | null } | { ok: false; error: unknown };

async function resolveUserIdByUsername(username: string): Promise<Resolved> {
  const literal = username.replace(/[\\%_*]/g, (c) => `\\${c}`);
  const { data, error } = await supabase
    .from("profile_bio")
    .select("user_id, username")
    .ilike("username", literal)
    .maybeSingle();
  if (error) return { ok: false, error };
  const row = data as { user_id?: string; username?: string } | null;
  const exact = typeof row?.username === "string" && row.username.trim().toLowerCase() === username;
  return { ok: true, userId: exact ? row?.user_id ?? null : null };
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

    const resolved = await resolveUserIdByUsername(probeUsername.toLowerCase());
    if (!resolved.ok) return apiErrorResponse(resolved.error, "api/profile/follows/probe");
    const followeeId = resolved.userId;
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

  // A failed bio read would render every followee as a nameless row.
  const { data: bios, error: biosErr } = await supabase
    .from("profile_bio")
    .select("user_id, username, display_name, avatar_url, accent_color")
    .in("user_id", followeeIds);
  if (biosErr) return apiErrorResponse(biosErr, "api/profile/follows/bios");

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

  const resolved = await resolveUserIdByUsername(String(username).toLowerCase());
  if (!resolved.ok) return apiErrorResponse(resolved.error, "api/profile/follows");
  const followeeId = resolved.userId;
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

  const resolved = await resolveUserIdByUsername(String(username).toLowerCase());
  if (!resolved.ok) return apiErrorResponse(resolved.error, "api/profile/follows");
  const followeeId = resolved.userId;
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
