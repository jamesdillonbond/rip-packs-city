// Data-access layer for the public moment page (app/moment/[id]/page.tsx).
//
// Extracted 2026-08-13 for the same two reasons as lib/pack-dist/fetchers.ts —
// see that module's header for the general argument — but the honesty half is
// sharper here, because of WHERE this page sits.
//
// ⚠ `/moment/[id]` is the platform's most-shared URL. Every moment link a
// collector posts into Discord, Twitter or a DM lands here. And `fetchDetail`
// returned a bare `null` for BOTH "no such moment" and "the RPC failed", with
// the page answering `notFound()` — so a statement timeout told a visitor, and
// told a crawler at HTTP 404, that a moment which plainly exists does not.
// That is the same defect as `loadSet` on /analytics/sets/[set_id] and
// `fetchLifecycle` on /[collection]/pack/[id], on a far higher-traffic surface.
//
// THE CONTRACT (identical to lib/pack-dist/fetchers.ts):
//   ok: false  →  the query FAILED. The caller must not render an empty value
//                 as a fact, and must never turn it into a 404.
//   ok: true   →  the question was answered. Empty data is a real "nothing here".
//
// ⚠ ONE SUBTLETY WORTH THE WORDS. `get_moment_detail` carries its OWN `ok` flag
// in the payload, meaning "I looked and there is no such moment". That is an
// ANSWER, so it comes back as `{ data: <payload>, ok: true }` and the page is
// free to 404 on it. Only a transport/RPC failure is `ok: false`. Collapsing the
// two `ok`s is exactly the bug this module exists to prevent, so they are
// deliberately never merged.
//
// `db` is injectable (defaults to supabaseAdmin) so every branch is testable
// without a database.

import { cache } from "react"
import { supabaseAdmin } from "@/lib/supabase"
import { mapNotableTagsToSpecialSerials } from "@/lib/moment-special-serials"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"

// ── BUDGET ──────────────────────────────────────────────────────────────────
// ⚠ Every read below already returns `ok: false` on an error, and the page
// already renders that distinction. None of it was reachable from the failure DB
// saturation actually produces: **a read that is merely SLOW errors nowhere** —
// supabase-js resolves `{ data, error }` only when the query finishes — so
// `/moment/[id]` hangs on a streaming shell that Vercel logs as a 200.
//
// ⚠ The bound REJECTS, and every call site here is already inside a `try/catch`
// that returns the honest failure. That is deliberate: routing the timeout into
// the branch each fetcher already has means bounding cannot introduce a second,
// divergent failure policy — the one risk in adding a bound to nine reads at once.
//
// ⚠ Page ceiling: `page.tsx` awaits `fetchMomentDetail` FIRST, then the other
// eight in ONE `Promise.all`. So the worst case is 4 + 4 = 8s, not 9 × 4.
// Anyone making a second sequential await must redo that arithmetic.
const MOMENT_READ_TIMEOUT_MS = 4_000

/**
 * Bound one read. Rejects on overrun, into the caller's existing catch.
 *
 * ⚠ Returns the `{ data, error }` envelope rather than a generic `T`, because
 * `Db` is `any` here (see above) — a generic would infer `unknown` and every
 * call site would stop compiling. Stating the envelope keeps the destructuring
 * at each site typed exactly as it was before the bound.
 */
function bounded(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  p: Promise<any>,
  label: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ data: any; error: { message: string } | null }> {
  return withBoardBudget(p, label, MOMENT_READ_TIMEOUT_MS, "moment-page/")
}


// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export interface RowResult<T> {
  data: T | null
  ok: boolean
}

export interface RowsResult<T> {
  rows: T[]
  ok: boolean
}

// ── Row shapes (moved verbatim from the page) ───────────────────────────────

export interface HighOffer {
  highest_offer: number | null
  low_ask: number | null
  updated_at: string | null
}

export interface MomentBestOffer {
  best_offer: number | null
  grain: string | null
  updated_at: string | null
}

export interface ParallelEdition {
  id: string
  external_id: string | null
  set_name: string | null
  tier: string | null
  series: number | null
  circulation_count: number | null
  thumbnail_url: string | null
  set_id_onchain: number | null
  player_name: string | null
}

export interface EditionBadge {
  id: string
  title: string
  source: string
}

export interface SpecialSerialRow {
  badge_type: string
  serial_number: number
}

export interface NotableSerialRow {
  serial: number
  tag: string
  last_sale_usd: number | null
  last_sold_at: string | null
  holder_address: string | null
  nft_id: string | null
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

// ── The gate ────────────────────────────────────────────────────────────────

/**
 * The RPC's payload, structurally. Its own `ok` is the "is there such a moment"
 * verdict — NOT the transport `ok` on the envelope. The page casts this to its
 * richer `MomentDetail`; keeping the full shape here would drag a dozen
 * presentation-only interfaces into the data layer for no benefit.
 */
export interface MomentDetailPayload {
  ok?: boolean
  [key: string]: unknown
}

/**
 * The moment payload. `cache()`d because generateMetadata and the page component
 * both need it, and React's per-request cache collapses the two calls into one.
 *
 * ⚠ Read the class comment above before touching the two `ok`s. `data.ok === false`
 * is the RPC saying "no such moment" — an ANSWER, so this returns `ok: true`.
 * Only a transport failure is `ok: false`, and only that may stop the caller
 * from 404ing.
 */
export const fetchMomentDetail = cache(async function fetchMomentDetail(
  id: string,
  db: Db = supabaseAdmin,
): Promise<RowResult<MomentDetailPayload>> {
  try {
    const { data, error } = await bounded(db.rpc("get_moment_detail", { p_id: id }), "detail")
    if (error) {
      console.warn(`[moment-page] rpc error id=${id}: ${error.message}`)
      return { data: null, ok: false }
    }
    return { data: (data as MomentDetailPayload | null) ?? null, ok: true }
  } catch (err) {
    console.warn(
      `[moment-page] fetch threw id=${id}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return { data: null, ok: false }
  }
})

// ── Auxiliary panels ────────────────────────────────────────────────────────

/** PostgREST returns either a single row or a one-element array; accept both. */
function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data.length > 0 ? (data[0] as T) : null)
  if (data && typeof data === "object") return data as T
  return null
}

export async function fetchHighOffer(
  editionId: string,
  db: Db = supabaseAdmin,
): Promise<RowResult<HighOffer>> {
  try {
    const { data, error } = await bounded(
      db.rpc("get_edition_high_offer", { p_edition_id: editionId }),
      "high-offer",
    )
    if (error) {
      console.warn(`[moment-page] high_offer rpc: ${error.message}`)
      return { data: null, ok: false }
    }
    return { data: firstRow<HighOffer>(data), ok: true }
  } catch (err) {
    console.warn(`[moment-page] high_offer threw: ${err instanceof Error ? err.message : String(err)}`)
    return { data: null, ok: false }
  }
}

export async function fetchMomentBestOffer(
  editionId: string,
  serial: number,
  db: Db = supabaseAdmin,
): Promise<RowResult<MomentBestOffer>> {
  try {
    const { data, error } = await bounded(
      db.rpc("get_moment_best_offer", { p_edition_id: editionId, p_serial: serial }),
      "best-offer",
    )
    if (error) {
      console.warn(`[moment-page] moment_best_offer rpc: ${error.message}`)
      return { data: null, ok: false }
    }
    return { data: firstRow<MomentBestOffer>(data), ok: true }
  } catch (err) {
    console.warn(
      `[moment-page] moment_best_offer threw: ${err instanceof Error ? err.message : String(err)}`,
    )
    return { data: null, ok: false }
  }
}

export async function fetchParallels(
  editionId: string,
  db: Db = supabaseAdmin,
): Promise<RowsResult<ParallelEdition>> {
  try {
    const { data, error } = await bounded(
      db.rpc("get_edition_parallels", { p_edition_id: editionId }),
      "parallels",
    )
    if (error) {
      console.warn(`[moment-page] parallels rpc: ${error.message}`)
      return { rows: [], ok: false }
    }
    return { rows: Array.isArray(data) ? (data as ParallelEdition[]) : [], ok: true }
  } catch (err) {
    console.warn(`[moment-page] parallels threw: ${err instanceof Error ? err.message : String(err)}`)
    return { rows: [], ok: false }
  }
}

/**
 * The parallel-printing ladder for the switcher (Top Shot only).
 *
 * ⚠ `fmv_usd` arrives from PostgREST as a numeric STRING, so it is coerced here.
 * Leave it as-is and the premium math silently concatenates instead of adding.
 */
export async function fetchSubeditionSiblings(
  externalId: string,
  db: Db = supabaseAdmin,
): Promise<RowsResult<SubeditionSibling>> {
  try {
    const { data, error } = await bounded(
      db.rpc("get_edition_subedition_siblings", { p_external_id: externalId }),
      "subedition-siblings",
    )
    if (error) {
      console.warn(`[moment-page] subedition_siblings rpc: ${error.message}`)
      return { rows: [], ok: false }
    }
    if (!Array.isArray(data)) return { rows: [], ok: true }
    return {
      ok: true,
      rows: (data as SubeditionSibling[]).map((s) => ({
        ...s,
        fmv_usd: s.fmv_usd != null ? Number(s.fmv_usd) : null,
      })),
    }
  } catch (err) {
    console.warn(
      `[moment-page] subedition_siblings threw: ${err instanceof Error ? err.message : String(err)}`,
    )
    return { rows: [], ok: false }
  }
}

export async function fetchBadges(
  editionId: string,
  db: Db = supabaseAdmin,
): Promise<RowsResult<EditionBadge>> {
  try {
    const { data, error } = await bounded(
      db.rpc("get_edition_badges_unified", { p_edition_id: editionId }),
      "badges",
    )
    if (error) {
      console.warn(`[moment-page] badges rpc: ${error.message}`)
      return { rows: [], ok: false }
    }
    return { rows: Array.isArray(data) ? (data as EditionBadge[]) : [], ok: true }
  } catch (err) {
    console.warn(`[moment-page] badges threw: ${err instanceof Error ? err.message : String(err)}`)
    return { rows: [], ok: false }
  }
}

export async function fetchSpecialSerialsForSerial(
  editionId: string,
  serial: number,
  db: Db = supabaseAdmin,
): Promise<RowsResult<SpecialSerialRow>> {
  try {
    const { data, error } = await bounded(
      db.rpc("get_edition_special_serials", { p_edition_id: editionId }),
      "special-serials",
    )
    if (error) {
      console.warn(`[moment-page] special_serials: ${error.message}`)
      return { rows: [], ok: false }
    }
    if (!Array.isArray(data)) return { rows: [], ok: true }
    return {
      ok: true,
      rows: mapNotableTagsToSpecialSerials(
        data as Array<{ serial: number | null; tag: string | null }>,
        serial,
      ),
    }
  } catch (err) {
    console.warn(`[moment-page] special_serials threw: ${err instanceof Error ? err.message : String(err)}`)
    return { rows: [], ok: false }
  }
}

export async function fetchEditionNotableSerials(
  editionId: string,
  db: Db = supabaseAdmin,
): Promise<RowsResult<NotableSerialRow>> {
  try {
    const { data, error } = await bounded(
      db.rpc("get_edition_special_serials", { p_edition_id: editionId }),
      "notable-serials",
    )
    if (error) {
      console.warn(`[moment-page] notable_serials rpc: ${error.message}`)
      return { rows: [], ok: false }
    }
    return { rows: Array.isArray(data) ? (data as NotableSerialRow[]) : [], ok: true }
  } catch (err) {
    console.warn(`[moment-page] notable_serials threw: ${err instanceof Error ? err.message : String(err)}`)
    return { rows: [], ok: false }
  }
}

/**
 * The live "Listed" ask for THIS serial, from cached_listings_v2.
 *
 * ⚠ The collection scope is REQUIRED and its absence is a deliberate REFUSAL,
 * not a failure. Flow nft_ids are unique only per CONTRACT, so `flow_id` alone
 * collides across collections — without the scope a Top Shot moment whose nft_id
 * equals an All Day listing's flow_id renders that other collection's price (the
 * 2026-07-03 QA finding). An unknown collection therefore returns `ok: true`
 * with no price: we chose not to answer, which is different from failing to.
 */
export async function fetchActiveListingAsk(
  nftId: string,
  collectionId: string | null,
  db: Db = supabaseAdmin,
): Promise<RowResult<number>> {
  const flowId = Number(nftId)
  if (!Number.isFinite(flowId)) return { data: null, ok: true }
  if (!collectionId) return { data: null, ok: true }
  try {
    const { data, error } = await bounded(
      Promise.resolve(
        db
          .from("cached_listings_v2")
          .select("price_usd")
          .eq("flow_id", flowId)
          .eq("collection_id", collectionId)
          .is("completed_at", null)
          .order("price_usd", { ascending: true })
          .limit(1),
      ),
      "active-listing-ask",
    )
    if (error) {
      console.warn(`[moment-page] active_listing: ${error.message}`)
      return { data: null, ok: false }
    }
    if (Array.isArray(data) && data.length > 0) {
      const p = Number(data[0]?.price_usd)
      return { data: Number.isFinite(p) && p > 0 ? p : null, ok: true }
    }
    return { data: null, ok: true }
  } catch (err) {
    console.warn(`[moment-page] active_listing threw: ${err instanceof Error ? err.message : String(err)}`)
    return { data: null, ok: false }
  }
}
