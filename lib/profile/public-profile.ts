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

import { cache } from "react"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"

/**
 * Wall-clock budget for the whole two-step bundle, shared across both steps.
 *
 * ⚠ Shared, not per-step: step 2 only runs if step 1 resolved, so two separate
 * budgets would let a saturated DB spend the budget twice and the bound would
 * double the worst case it exists to cap.
 *
 * ⚠ Bounding is safe here ONLY because both callers already handle `ok: false`
 * — the API route forwards `status`, and `ProfileClient` re-fetches every field
 * on mount, so the SSR payload is a first-paint optimisation rather than the
 * page's only source. Bounding a page with no degraded branch would turn a slow
 * page into a thrown error boundary, which is worse than slow.
 */
const PUBLIC_PROFILE_TIMEOUT_MS = 6_000

/**
 * ⚠ 503, NEVER 404. A read we could not finish is not evidence the profile does
 * not exist, and 404 is the one status that says it does not — on a page
 * collectors SHARE. Same reason the module already distinguishes `idErr` (500)
 * from `!idRow` (404): the two answers look identical downstream and only one
 * of them is true.
 */
const TIMEOUT_STATUS = 503

/**
 * A PostgREST row as this module has always handled it — loosely, because the
 * shape guarantee lives at the exported boundary (`PublicProfileBio` and
 * friends) rather than at each query. Declared once so the budget wrappers below
 * do not each need their own escape hatch.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any

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
  /**
   * Portion of `cached_fmv` whose latest FMV confidence is STALE, and how many
   * Moments that is. The dashboard holds stale value OUT of its headline
   * (`get_wallet_collection_stats.fmv_stale_total`); until 2026-09-02 this
   * payload could not, so the public profile / OG / tweet published a number
   * 80% above the one the collector's own dashboard showed. Headline =
   * `cached_fmv - cached_fmv_stale`. Null = not yet reconciled (treat as 0).
   */
  cached_fmv_stale: number | null
  cached_stale_count: number | null
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
  /**
   * DISTINCT wallet ADDRESSES, which is not `wallets.length`.
   *
   * ⚠ `saved_wallets` is keyed per (wallet_addr, collection_id), so pinning ONE
   * address produces one row per collection it holds moments in — Trevor's
   * single Dapper wallet is four rows, and the profile read "4 WALLETS".
   *
   * It has to be computed HERE and shipped as a scalar: `wallet_addr` is
   * deliberately stripped from `wallets` below (the privacy step), so no
   * consumer of this payload is able to derive it. A count is not an address,
   * so publishing the number leaks nothing the page did not already claim.
   */
  wallet_count: number
}

export type PublicProfileResult =
  | { ok: true; data: PublicProfilePayload }
  // ⚠ 503 added 2026-08-22 for a read that OVERRAN its budget. It is a distinct
  // status from 500 on purpose: 500 says the database answered with an error,
  // 503 says it did not answer. Both are honest; neither is 404, which is the
  // one status that would tell a visitor the profile does not exist.
  | { ok: false; status: 400 | 404 | 500 | 503; error: string; username?: string }

/**
 * Request-scoped memo. `/profile/<username>` now has TWO server callers in the
 * same render pass — the page shell and the layout's `generateMetadata` — and
 * without this they would each run the resolve + 3-way fan-out, doubling the
 * cost of the fix that removed the self-fetch in the first place. React's
 * `cache()` is per-request, so this dedupes within one render and shares
 * nothing between users.
 *
 * ⚠ It keys on the ARGUMENTS, so both server callers must pass the same
 * `source`. They both pass "ssr"; a caller that invents its own label silently
 * misses the memo and pays full price while every test still passes.
 */
export const getPublicProfile = cache(getPublicProfileUncached)

async function getPublicProfileUncached(
  rawUsername: string,
  source = "api"
): Promise<PublicProfileResult> {
  const startedAt = Date.now()
  const handle = (rawUsername || "").trim().toLowerCase()
  console.log(`[public/profile:${source}] start username=${handle}`)

  if (!handle) return { ok: false, status: 400, error: "username required" }

  // ⚠ BOUNDED. A read that is merely SLOW errors nowhere — supabase-js resolves
  // `{ data, error }` only when the query finishes — so under DB saturation this
  // await never returns and `/profile/[username]` + `/profile/[username]/trophy-case`
  // hang on a streaming shell that Vercel logs as a 200. Fourth occurrence of the
  // unbounded-server-read class; see scripts/check-unbounded-server-reads.mjs.
  const deadline = Date.now() + PUBLIC_PROFILE_TIMEOUT_MS
  const remaining = () => Math.max(1, deadline - Date.now())

  // Step 1: username -> user_id.
  const resolveT0 = Date.now()
  let idRow: Row
  let idErr: { message: string } | null = null
  try {
    ;({ data: idRow, error: idErr } = await withBoardBudget<{
      data: Row
      error: { message: string } | null
    }>(
      Promise.resolve(
        supabase.from("profile_bio").select("user_id").ilike("username", handle).maybeSingle(),
      ),
      "public-profile-resolve",
      remaining(),
      "profile/",
    ))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[public/profile resolve] bound:", msg)
    return { ok: false, status: TIMEOUT_STATUS, error: msg }
  }
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
  let bio: Row
  let bioErr: { message: string } | null = null
  let trophyData: Row
  let wallets: Row
  try {
    ;[{ data: bio, error: bioErr }, { data: trophyData }, { data: wallets }] = await withBoardBudget<
      [{ data: Row; error: { message: string } | null }, { data: Row }, { data: Row }]
    >(
      Promise.all([
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
        // wallet_addr is selected but NEVER published — it exists only to count
        // distinct addresses below, and is dropped in the mapping step.
        "wallet_addr, username, display_name, collection_id, cached_fmv_usd, cached_fmv_stale_usd, cached_stale_count, cached_moment_count, cached_top_tier, cached_badges, accent_color, cached_rpc_score, cached_change_24h"
      )
      .eq("user_id", userId),
      ]) as Promise<
        [{ data: Row; error: { message: string } | null }, { data: Row }, { data: Row }]
      >,
      "public-profile-bundle",
      remaining(),
      "profile/",
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[public/profile bundle] bound:", msg)
    return { ok: false, status: TIMEOUT_STATUS, error: msg }
  }

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

  // Count DISTINCT addresses before the strip below, which is the only point
  // in the pipeline where they still exist. Rows with a null/blank address are
  // not counted — a row we cannot attribute to an address is not evidence of
  // another wallet.
  const walletCount = new Set(
    (wallets ?? [])
      .map((w: any) => (typeof w.wallet_addr === "string" ? w.wallet_addr.trim().toLowerCase() : ""))
      .filter((a: string) => a !== "")
  ).size

  // Strip wallet ADDRESSES from the public payload — load-bearing privacy step.
  const walletSummaries: PublicProfileWallet[] = (wallets ?? []).map((w: any) => ({
    username: w.username ?? null,
    display_name: w.display_name ?? null,
    collection_id: w.collection_id,
    cached_fmv: w.cached_fmv_usd ?? null,
    cached_fmv_stale: w.cached_fmv_stale_usd ?? null,
    cached_stale_count: w.cached_stale_count ?? null,
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
      wallet_count: walletCount,
    },
  }
}
