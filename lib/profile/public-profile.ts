// lib/profile/public-profile.ts
//
// Shared data layer for the PUBLIC profile bundle (trophy moments + bio +
// privacy-stripped saved-wallet summaries for a username).
//
// WHY THIS MODULE EXISTS (2026-08-07). Two callers need this exact payload:
//   • app/api/public/profile/[username]/route.ts  — the anon JSON endpoint
//   • app/profile/[username]/page.tsx             — the SSR shell
// The page used to obtain it by making a server-side HTTP round trip back to
// its own API route with `cache: "no-store"`, on a `force-dynamic` page. That
// cost TWO lambda invocations plus uncached DB work for every single request —
// on the heaviest uncached public route (14,652 hits/12h during the 2026-08-06
// crawl, which is also most of the 10,723 hits attributed to the API route
// itself; the page was calling itself). It also created a failure mode where
// the page 500s purely because its own API got rate limited.
//
// The self-fetch existed for a real reason — it guaranteed the page and the
// client saw ONE payload shape, with zero divergence. That guarantee is
// preserved here by extraction, NOT by duplicating the query in two places:
// both callers now invoke this single function. Do not inline it back into
// either caller.
//
// Lookup pattern (unchanged, load-bearing): username (URL path param) ->
// user_id (resolved via the denormalized `profile_bio.username` cache) ->
// profile_bio.user_id (full row) -> trophies / saved_wallets (keyed on
// user_id, the only canonical foreign key into auth.users). Never join
// trophies / saved_wallets to profile_bio.username directly — that column is a
// cache, the source of truth is auth.users.id.

import { supabaseAdmin as supabase } from "@/lib/supabase"

// These mirror the prop types ProfileClient declares (ProfileBio /
// SavedWalletPublic). They are stated explicitly rather than left loose
// because the page now passes this result straight into the client as typed
// props — under the old HTTP self-fetch the payload arrived as `any` from
// JSON, so a shape drift between this query and the client compiled silently.
// Typing it here means a divergence is a BUILD error, not a runtime blank.
export type PublicProfileBio = {
  display_name: string | null
  tagline: string | null
  favorite_team: string | null
  twitter: string | null
  discord: string | null
  avatar_url: string | null
  accent_color?: string | null
  equipped_border?: string | null
  equipped_banner?: string | null
}

export type PublicProfileWallet = {
  username: string | null
  display_name: string | null
  collection_id: string | null
  cached_fmv: number | null
  cached_moment_count: number | null
  cached_top_tier: string | null
  cached_badges: string[] | null
  accent_color: string
  cached_rpc_score: number | null
  cached_change_24h: number | null
}

export type PublicProfilePayload = {
  username: string
  bio: PublicProfileBio
  trophies: Record<string, unknown>[]
  wallets: PublicProfileWallet[]
}

export type PublicProfileResult =
  | { ok: true; data: PublicProfilePayload }
  | { ok: false; status: 400 | 404 | 500; error: string; username?: string }

export async function getPublicProfile(
  rawUsername: string,
  source = "api"
): Promise<PublicProfileResult> {
  const startedAt = Date.now()
  const handle = (rawUsername || "").trim().toLowerCase()
  console.log(`[public/profile:${source}] start username=${handle}`)

  if (!handle) return { ok: false, status: 400, error: "username required" }

  // Step 1: username -> user_id.
  const resolveT0 = Date.now()
  const { data: idRow, error: idErr } = await supabase
    .from("profile_bio")
    .select("user_id")
    .ilike("username", handle)
    .maybeSingle()
  console.log(
    `[public/profile:${source}] resolve username->user_id elapsedMs=${Date.now() - resolveT0} found=${!!idRow}`
  )

  if (idErr) {
    console.error("[public/profile resolve]", idErr)
    return { ok: false, status: 500, error: idErr.message }
  }
  if (!idRow) {
    console.log(`[public/profile:${source}] not_found elapsedMs=${Date.now() - startedAt}`)
    return { ok: false, status: 404, error: "Not found", username: handle }
  }

  const userId = (idRow as any).user_id as string

  // Step 2: full bio + trophies + wallets in parallel, all keyed on user_id.
  // Trophies resolve through get_trophy_slab_data_by_username — the SAME live
  // RPC the owner dashboard + public page use — so anon visitors / OG unfurls
  // see LIVE tier + fmv, not the pin-time values frozen in trophy_moments
  // (which carry null tiers + stale prices). We map back to this endpoint's
  // existing field set and intentionally DROP the RPC's acquired_price /
  // acquisition_method so the public payload never leaks owner cost basis /
  // P&L. (fix 2026-06-15)
  const fanT0 = Date.now()
  const [{ data: bio, error: bioErr }, { data: trophyData }, { data: wallets }] = await Promise.all([
    supabase
      .from("profile_bio")
      .select(
        "username, display_name, tagline, favorite_team, twitter, discord, avatar_url, accent_color, equipped_border, equipped_banner"
      )
      .eq("user_id", userId)
      .maybeSingle(),
    supabase.rpc("get_trophy_slab_data_by_username", { p_username: handle }),
    supabase
      .from("saved_wallets")
      .select(
        "username, display_name, collection_id, cached_fmv_usd, cached_moment_count, cached_top_tier, cached_badges, accent_color, cached_rpc_score, cached_change_24h"
      )
      .eq("user_id", userId),
  ])

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
  }))

  if (bioErr) {
    console.error("[public/profile bio]", bioErr)
    return { ok: false, status: 500, error: bioErr.message }
  }
  if (!bio) {
    console.log(`[public/profile:${source}] bio_missing_for_user_id elapsedMs=${Date.now() - startedAt}`)
    return { ok: false, status: 404, error: "Not found", username: handle }
  }
  console.log(
    `[public/profile:${source}] trophies+wallets parallel elapsedMs=${Date.now() - fanT0} trophies=${trophies?.length ?? 0} wallets=${wallets?.length ?? 0}`
  )

  // Strip wallet ADDRESSES from the public payload — load-bearing privacy step.
  const walletSummaries: PublicProfileWallet[] = (wallets ?? []).map((w: any) => ({
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
  }))

  console.log(`[public/profile:${source}] done elapsedMs=${Date.now() - startedAt}`)
  return {
    ok: true,
    data: {
      username: bio.username as string,
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
    },
  }
}
