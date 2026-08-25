// app/api/profile/top-moments/route.ts
//
// Returns the top FMV-ranked moments owned across the current user's saved
// wallets. Backs the trophy-case "Pick from collection" picker modal so users
// can pin moments without bouncing through the collection page.
//
// Resolution order for the user_id:
//   1. ?ownerKey=<wallet_addr | username> query param (when supplied)
//   2. Authenticated session (requireUser fallback)
//
// Optional ?collection=<slug> filters to one collection (e.g. "nba-top-shot")
// and routes to the 4-arg overload of get_user_top_owned_moments which adds a
// COALESCE thumbnail fallback chain (wmc.image_url → editions.thumbnail_url →
// pinnacle_editions.thumbnail_url → topshot CDN derive). The 3-arg overload
// returned wmc.image_url verbatim, which is NULL for ~all rows and was the
// reason every pinned trophy ended up with thumbnail_url IS NULL.

import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-error";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth/supabase-server";
import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections";

// ⚠ HONESTY CANON, and this is the sub-class CLAUDE.md names as WORST: a false
// claim about the reader's own account. Both lookups below used to destructure
// only `data`. supabase-js RESOLVES on a query error, so a FAILED read of an
// explicitly-requested `ownerKey` fell straight through to `getCurrentUser()` —
// and the route answered with THE VIEWER'S OWN moments under someone else's
// ownerKey. That is not an empty answer, it is a DIFFERENT one, the same shape
// as the `/api/cost-basis` collection-filter defect. The other branch is no
// better: an anonymous caller got 401 "Authentication required" out of a
// database timeout, which sends a signed-out reader to sign in for nothing and
// a signed-in one nowhere at all.
//
// The documented resolution order is preserved exactly — an ownerKey that
// genuinely resolves to nobody still falls back to the session, because that is
// the contract in this file's header. What is no longer allowed is for a read
// FAILURE to be spelled the same way as "no such owner".
type OwnerResolution =
  | { ok: true; userId: string | null }
  | { ok: false; error: unknown };

async function resolveUserId(ownerKey: string | null): Promise<OwnerResolution> {
  if (ownerKey) {
    const key = ownerKey.trim();
    if (key.startsWith("0x")) {
      const { data, error } = await supabase
        .from("saved_wallets")
        .select("user_id")
        .eq("wallet_addr", key.toLowerCase())
        .limit(1)
        .maybeSingle();
      if (error) return { ok: false, error };
      if (data?.user_id) return { ok: true, userId: data.user_id as string };
    }
    const { data: bio, error: bioErr } = await supabase
      .from("profile_bio")
      .select("user_id")
      .eq("username", key)
      .maybeSingle();
    if (bioErr) return { ok: false, error: bioErr };
    if (bio?.user_id) return { ok: true, userId: bio.user_id as string };
  }
  const user = await getCurrentUser();
  return { ok: true, userId: user?.id ?? null };
}

export async function GET(req: NextRequest) {
  const ownerKey = req.nextUrl.searchParams.get("ownerKey");
  const limitRaw = Number(req.nextUrl.searchParams.get("limit") ?? 24);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 96
    ? Math.floor(limitRaw)
    : 24;
  const leagueRaw = req.nextUrl.searchParams.get("league");
  const league = leagueRaw === "NBA" || leagueRaw === "WNBA" ? leagueRaw : null;
  const collectionSlug = req.nextUrl.searchParams.get("collection");
  const collectionUuid = collectionSlug ? COLLECTION_UUID_BY_SLUG[collectionSlug] ?? null : null;

  const owner = await resolveUserId(ownerKey);
  if (!owner.ok) {
    console.error("[profile/top-moments] owner resolve failed", (owner.error as { message?: string })?.message);
    return apiErrorResponse(owner.error, "api/profile/top-moments");
  }
  const userId = owner.userId;
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { data, error } = await supabase.rpc("get_user_top_owned_moments", {
    p_user_id: userId,
    p_limit: limit,
    p_league: league,
    p_collection_id: collectionUuid,
  });

  if (error) {
    console.error("[profile/top-moments]", error.message);
    return apiErrorResponse(error, "api/profile/top-moments");
  }

  return NextResponse.json({ moments: data ?? [] });
}
