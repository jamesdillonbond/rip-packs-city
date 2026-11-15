// app/api/profile/top-moments/route.ts
//
// Returns the top FMV-ranked moments owned across the current user's saved
// wallets. Backs the trophy-case "Pick from collection" picker modal so users
// can pin moments without bouncing through the collection page.
//
// Resolution order for the user_id:
//   1. ?ownerKey=<wallet_addr | username> query param (when supplied)
//   2. Authenticated session (requireUser fallback)
//   ?strict=1 (#148): a supplied ownerKey that resolves to nobody answers 404
//   owner_not_found, never the session. Any page about someone else sends it.
//
// Optional ?collection=<slug> filters to one collection (e.g. "nba-top-shot").
// get_user_top_owned_moments carries a thumbnail fallback chain (wmc.image_url
// → editions.thumbnail_url → pinnacle_editions.thumbnail_url); for Top Shot it
// always derives the per-Moment media URL (2026-11-06: the cached Series-1
// edition hero assets are dead upstream). The old 3-arg overload returned
// wmc.image_url verbatim, which is NULL for ~all rows and was the reason every
// pinned trophy ended up with thumbnail_url IS NULL.
//
// Optional ?q=<name> (2026-11-06): a typed name is searched across the WHOLE
// wallet server-side (player / set / team / character / edition name,
// case-insensitive substring) BEFORE the fmv cap. Without it the trophy picker
// searched inside the 96 highest-value rows it had loaded, and a collector with
// 15,706 Moments found six of his Damian Lillards. Trimmed, capped at 80 chars;
// blank = no filter.

import { NextRequest, NextResponse } from "next/server";
import { resolveOwnOwner } from "@/lib/profile/own-owner";
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections";
import { ownLookup } from "@/lib/safe-lookup";

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

/** Deepest page "Load more" may ask for (~100 pages of the picker's 96). */
const MAX_OFFSET = 9600;

export async function GET(req: NextRequest) {
  const ownerKey = req.nextUrl.searchParams.get("ownerKey");
  const limitRaw = Number(req.nextUrl.searchParams.get("limit") ?? 24);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 96
    ? Math.floor(limitRaw)
    : 24;
  const leagueRaw = req.nextUrl.searchParams.get("league");
  const league = leagueRaw === "NBA" || leagueRaw === "WNBA" ? leagueRaw : null;
  const collectionSlug = req.nextUrl.searchParams.get("collection");
  const collectionUuid = collectionSlug ? ownLookup(COLLECTION_UUID_BY_SLUG, collectionSlug) ?? null : null;
  // ⛔ SUBSTITUTION: an unrecognised slug used to fall through to `null` —
  // "every collection" — so a picker filtered to a collection this map does not
  // know answered with the collector's Top Shot Moments under that label. A
  // named filter we cannot honour is refused, never widened. (An ABSENT param
  // still means all collections.)
  if (collectionSlug && !collectionUuid) {
    return NextResponse.json({ error: "unknown_collection" }, { status: 400 });
  }

  const strict = req.nextUrl.searchParams.get("strict") === "1";
  const qRaw = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 80);
  const query = qRaw.length > 0 ? qRaw : null;
  // ?offset=<n> (2026-11-08): "Load more" in the trophy picker pages the same
  // fmv-ordered list. Whole numbers 0..MAX_OFFSET; anything else is page one.
  const offsetRaw = Number(req.nextUrl.searchParams.get("offset") ?? 0);
  const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 && offsetRaw <= MAX_OFFSET ? offsetRaw : 0;
  // 2026-11-14 (account review): only the SIGNED-IN viewer's own moments — lib/profile/own-owner.ts.
  const owner = await resolveOwnOwner(supabase, ownerKey, strict, "api/profile/top-moments");
  if (!owner.ok) {
    if (owner.status === 500) {
      console.error("[profile/top-moments] owner resolve failed", (owner.cause as { message?: string })?.message);
      return apiErrorResponse(owner.cause, "api/profile/top-moments");
    }
    return NextResponse.json({ error: owner.error }, { status: owner.status });
  }
  const userId = owner.userId;

  const { data, error } = await boundedRead(supabase.rpc("get_user_top_owned_moments", {
    p_user_id: userId,
    p_limit: limit,
    p_league: league,
    p_collection_id: collectionUuid,
    p_query: query,
    // Sent only for a later page, so a first-page call names exactly the
    // arguments every deployed signature of the RPC has had.
    ...(offset > 0 ? { p_offset: offset } : {}),
  }), "api/profile/top-moments/get_user_top_owned_moments");

  if (error) {
    console.error("[profile/top-moments]", error.message);
    return apiErrorResponse(error, "api/profile/top-moments");
  }

  // PANINI ROWS ARE OPT-IN (2026-09-28). The RPC now also returns cards under
  // the user's linked Panini usernames, but only the trophy picker can pin one
  // (the hero and avatar pickers resolve a Moment by its RPC moment page, which
  // a Panini card does not have). So an unfiltered caller gets them only with
  // `panini=1`. ⚠ Dropping them here can leave an opted-out list shorter than
  // `limit` when Panini cards rank inside it — it never adds a Panini row.
  const includePanini =
    collectionSlug === "panini-blockchain" || req.nextUrl.searchParams.get("panini") === "1";
  // A FULL page from the RPC means there may be more; measured BEFORE the
  // Panini opt-out below, which can shorten a page without ending the list.
  const hasMore = (data ?? []).length >= limit;
  const rows = ((data ?? []) as { collection_id?: string }[]).filter(
    (r) => includePanini || r.collection_id !== COLLECTION_UUID_BY_SLUG["panini-blockchain"]
  );

  // PANINI (2026-09-28): the Panini branch of the RPC reads the usernames the
  // user LINKED, not a wallet. An empty Panini list has two different truths —
  // "no username linked" (go link one) vs "linked, but nothing read under it
  // yet" — so the filtered response says which. null = the count read failed:
  // the picker then says neither, rather than guessing.
  // The trophy picker (panini=1) also asks on its FIRST page with no filter, so a
  // challenge that takes Panini can say where the username goes (2026-11-08).
  if (collectionSlug === "panini-blockchain" || (includePanini && offset === 0)) {
    const linked = await countLinkedPaniniUsernames(supabase, userId);
    return NextResponse.json({ moments: rows, hasMore, paniniUsernamesLinked: linked });
  }

  return NextResponse.json({ moments: rows, hasMore });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function countLinkedPaniniUsernames(db: any, userId: string): Promise<number | null> {
  try {
    const { count, error } = await db
      .from("saved_collector_identities")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("collection_id", COLLECTION_UUID_BY_SLUG["panini-blockchain"])
      .eq("identity_kind", "username");
    if (error) {
      console.error("[profile/top-moments] panini username count failed", error.message);
      return null;
    }
    return typeof count === "number" ? count : null;
  } catch (err) {
    console.error("[profile/top-moments] panini username count failed", err instanceof Error ? err.message : err);
    return null;
  }
}
