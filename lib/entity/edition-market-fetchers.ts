// lib/entity/edition-market-fetchers.ts
//
// The two edition-page fetchers that lib/entity-section-rpc.ts deliberately does
// NOT model, extracted out of `app/(collections)/[collection]/edition/[slug]/page.tsx`.
//
// ── WHY THEY LIVE HERE ──────────────────────────────────────────────────────
// `app/**/page.tsx` is measured by NEITHER coverage gate — the primary gate's
// include stops at `route.{ts,tsx}` and the component gate's at `*Client.tsx` —
// so ~44,000 LOC of server pages, 35 of which query Supabase inline, contribute
// nothing to either ratchet. `__tests__/server-page-data-access-ratchet.test.ts`
// freezes that count; the remedy it names is EXTRACTION, because a fetcher in
// `lib/` is watched by a gate and a fetcher in a page is not.
//
// These two were the edition page's LAST direct `supabaseAdmin` users — every
// other section already routes through entity-section-rpc — so moving them drops
// that page out of the ratchet entirely (35 → 34).
//
// ── WHY NOT sectionRows ─────────────────────────────────────────────────────
// entity-section-rpc models a `[]` / `null` contract. Both fetchers here have a
// bespoke non-empty default (a typed bundle object), so routing them through it
// would change their shape — that exclusion is documented in that module and is
// still correct. They keep their own error handling; what they gain here is
// `ok`, and a gate.
//
// ── ON `ok` ─────────────────────────────────────────────────────────────────
// Returned but NOT currently consumed by the page, deliberately, and this is the
// unusual case where that is right: every render site on the edition page gates
// on `!= null` or `length >= 2`, so a failed read already degrades to an
// em-dash or a hidden section rather than a fabricated `0` or `0.0% listed`.
// An omission understates, which is the safe direction — the same reasoning
// CLAUDE.md records for the serial-quirk chips.
//
// It is exported because that safety is a property of the CURRENT call sites,
// not of the data. The moment any consumer wants to render a figure
// unconditionally — a "% Listed" that shows `0.0%` instead of `—`, or a
// "no parallels" line where the ladder is hidden today — it needs `ok` to tell a
// failed read from a genuinely empty one, and it should not have to re-derive
// that distinction. See `__tests__/lib-edition-market-fetchers.test.ts`, which
// pins both the shapes and that safety property.
//
// ⚠ `rpcWithRetry`, not a bare `.rpc()`. Both sit in the page's BLOCKING shell
// `Promise.all`, and a bare call has no wall-clock bound at all — a stuck
// connection-acquire parked the whole render on "SCANNING THE MARKETPLACE…"
// until Vercel killed the function at 300 s. `market_bundle` is the single most
// frequent edition error in production, so the bound is load-bearing here.

import { supabaseAdmin } from "@/lib/supabase"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"

export interface HighOffer {
  highest_offer: number | null
  low_ask: number | null
  updated_at: string | null
  /**
   * 'parallel' = the offer applies to THIS printing (subedition-scoped, or the
   * printing's own marketplace top offer); 'edition' = an edition-wide offer
   * fillable by any printing. Drives the Best-offer cell label on `::` pages, so
   * losing the distinction would advertise an edition-wide offer as specific to
   * one parallel.
   */
  offer_scope?: string | null
}

/**
 * IPFS CID data still arrives on the bundle (topshot_ipfs_assets) but is no
 * longer rendered — the "Media Verified on IPFS" section was removed 2026-07-11
 * (build-time plumbing, not front-end content). The type stays so the bundle
 * shape remains documented.
 */
export interface IpfsAsset {
  video_cid: string | null
  hero_cid: string | null
}

export interface SubeditionSibling {
  external_id: string
  subedition_id: number | null
  subedition_name: string | null
  circulation_count: number | null
  thumbnail_url: string | null
  fmv_usd: number | null
  confidence: string | null
  is_self: boolean
}

export interface MarketBundle {
  high_offer: HighOffer | null
  ipfs_assets: IpfsAsset | null
  subedition_siblings: SubeditionSibling[]
  /**
   * Count of open market listings for this edition ("% Listed").
   *
   * `null` = no fresh listing source for the collection (Top Shot's ts_listings
   * feed is dead; UFC/Pinnacle have none) → the page renders an em-dash, never a
   * fake 0%. `0` = a live source with nothing currently listed, i.e. an honest
   * "0.0% listed". Collapsing those two is how a dead feed becomes a market
   * claim, so the distinction must survive any refactor of this field.
   */
  active_listings: number | null
}

export interface InsightLinks {
  squeeze_pct: number | null
  deal_pct: number | null
  first_mint_x: number | null
}

/** `ok` answers "did the READ succeed", never "were there rows". */
export interface FetchResult<T> {
  data: T
  ok: boolean
}

export const EMPTY_MARKET_BUNDLE: MarketBundle = {
  high_offer: null,
  ipfs_assets: null,
  subedition_siblings: [],
  active_listings: null,
}

export const EMPTY_INSIGHT_LINKS: InsightLinks = {
  squeeze_pct: null,
  deal_pct: null,
  first_mint_x: null,
}

/** Injectable for tests; defaults to the service-role client the page used. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

/**
 * high_offer + subedition (parallel) ladder + IPFS assets + listing count in ONE
 * pooled connection — `get_edition_market_bundle` composes the three SECDEF
 * helpers server-side, cutting the hero fan-out from 3 round-trips to 1.
 */
export async function fetchMarketBundle(
  editionId: string,
  externalId: string | null,
  db: Db = supabaseAdmin,
): Promise<FetchResult<MarketBundle>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await rpcWithRetry<any>(db as never, "get_edition_market_bundle", {
    p_edition_id: editionId,
    p_external_id: externalId,
  })
  if (error) {
    console.error("[edition] market_bundle", error.message)
    return { data: EMPTY_MARKET_BUNDLE, ok: false }
  }
  return {
    data: {
      high_offer: (data?.high_offer ?? null) as HighOffer | null,
      ipfs_assets: (data?.ipfs_assets ?? null) as IpfsAsset | null,
      subedition_siblings: Array.isArray(data?.subedition_siblings)
        ? (data.subedition_siblings as SubeditionSibling[])
        : [],
      // Strictly `typeof === "number"`: a string "0" or a null must NOT become a
      // count, or a dead listing feed starts publishing "0.0% listed".
      active_listings: typeof data?.active_listings === "number" ? data.active_listings : null,
    },
    ok: true,
  }
}

/**
 * "Featured in Insights" membership — Top Shot only. Bundled into ONE RPC so the
 * page holds a single pooled connection instead of three separate view reads.
 */
export async function fetchInsightLinks(
  editionId: string,
  externalId: string | null,
  db: Db = supabaseAdmin,
): Promise<FetchResult<InsightLinks>> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await rpcWithRetry<any>(db as never, "get_edition_insight_links", {
      p_edition_id: editionId,
      p_external_id: externalId,
    })
    if (error) {
      console.error("[edition] insight_links", error.message)
      return { data: EMPTY_INSIGHT_LINKS, ok: false }
    }
    return {
      data: {
        squeeze_pct: data?.squeeze_pct ?? null,
        deal_pct: data?.deal_pct ?? null,
        first_mint_x: data?.first_mint_x ?? null,
      },
      ok: true,
    }
  } catch (e) {
    // ⚠ The try/catch is NOT redundant with the `error` branch. supabase-js
    // RETURNS a Postgrest error but THROWS on a transport failure, so without
    // this a network blip escapes into the page's blocking Promise.all and takes
    // down the whole render rather than degrading one decorative strip.
    console.error("[edition] insight_links", e instanceof Error ? e.message : String(e))
    return { data: EMPTY_INSIGHT_LINKS, ok: false }
  }
}
