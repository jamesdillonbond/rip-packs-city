// lib/entity-detail-gate.ts
//
// The shared, per-request-memoized detail fetch behind the five SEO entity
// routes (edition / set / player / team / series) AND the existence gate their
// segment layouts use to return a REAL 404 for an unknown slug.
//
// ── Why a layout gate at all (2026-07-25 soft-404 fix) ──────────────────────
// Each of those segments ships a `loading.tsx`. That makes Next wrap the PAGE in
// an implicit <Suspense>, flush the document shell + fallback immediately, and
// stream the page afterwards — so by the time the page's own `notFound()` fires
// the HTTP status line has already gone out as **200**. The 404 then arrives as
// a streamed error row (`NEXT_HTTP_ERROR_FALLBACK;404`) and the response is a
// textbook soft-404: HTTP 200 with a "not found" body. Google treats those as
// thin duplicate pages, and ~20,500 sitemap URLs sit on these five routes.
//
// Verified empirically against Next 16.2.9 (this repo's version), unknown slug:
//   loading.tsx + notFound() in the page ............ 200  (the bug)
//   loading.tsx + notFound() in generateMetadata .... 200  (metadata streams too)
//   loading.tsx + notFound() in a segment layout .... 404  <- what we ship
//   no loading.tsx + notFound() in the page ......... 404  (loses the skeleton)
// A layout is part of the shell, so Next must await it BEFORE the first flush.
// Shipped first for app/moment/[id] (e835882c); this is the same pattern.
//
// ── Two properties that make this safe ─────────────────────────────────────
//  1. STRICT SUBSET. The gate calls the *same* `get_<entity>_detail` RPC the
//     page itself 404s on, with the same arguments — so it cannot invent a 404
//     for a slug that would have rendered.
//  2. FAILS OPEN. Any RPC error (or thrown exception) is treated as "exists".
//     A transient pool blip must never emit a 404 and invite Google to drop a
//     real page; the page keeps its own error/not-found handling as backstop.
//
// ── And it is not extra work ────────────────────────────────────────────────
// `fetchEntityDetailRaw` is React-`cache()`d, and every page's own `fetchDetail`
// (plus its `generateMetadata`) now goes through it. The layout's gate, the
// metadata fetch and the page render therefore collapse into ONE round trip per
// request, where previously metadata + page already made two.

import { cache } from "react"
import { supabaseAdmin } from "@/lib/supabase"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"

export type EntityKind = "edition" | "set" | "player" | "team" | "series"

const SPEC: Record<EntityKind, { fn: string; slugArg: string }> = {
  edition: { fn: "get_edition_detail", slugArg: "p_route_slug" },
  set: { fn: "get_set_detail", slugArg: "p_set_slug" },
  player: { fn: "get_player_detail", slugArg: "p_player_slug" },
  team: { fn: "get_team_detail", slugArg: "p_team_slug" },
  series: { fn: "get_series_detail", slugArg: "p_series_slug" },
}

export interface EntityDetailResult {
  data: unknown
  error: { message: string } | null
}

// Per-request memoized. Same (kind, collectionId, slug) => one RPC per request.
export const fetchEntityDetailRaw = cache(
  async (kind: EntityKind, collectionId: string, slug: string): Promise<EntityDetailResult> => {
    const { fn, slugArg } = SPEC[kind]
    const { data, error } = await rpcWithRetry(supabaseAdmin as never, fn, {
      p_collection_id: collectionId,
      [slugArg]: slug,
    })
    return { data: data ?? null, error: error ?? null }
  },
)

// These RPCs return either a single jsonb object or a one-row array.
export function firstEntityRow<T>(data: unknown): T | null {
  if (data == null) return null
  if (Array.isArray(data)) return (data[0] as T) ?? null
  return data as T
}

/**
 * Does this slug resolve to a real entity?
 *
 * Returns FALSE only when the resolver ran cleanly and returned nothing —
 * i.e. only when the page itself would definitely have called notFound().
 * Any error, or a thrown exception, returns TRUE (fail open).
 */
export async function entityResolves(
  kind: EntityKind,
  collectionId: string,
  slug: string,
): Promise<boolean> {
  try {
    const { data, error } = await fetchEntityDetailRaw(kind, collectionId, slug)
    if (error) {
      console.warn(`[${kind}-layout] detail rpc error slug=${slug}: ${error.message} — failing OPEN`)
      return true
    }
    return firstEntityRow(data) != null
  } catch (err) {
    console.warn(
      `[${kind}-layout] detail rpc threw slug=${slug}: ${err instanceof Error ? err.message : String(err)} — failing OPEN`,
    )
    return true
  }
}

// Next hands the [slug] segment URL-encoded and the pages all decode it before
// hitting the RPC. `decodeURIComponent` THROWS on a malformed escape (e.g. a
// bare "%"), so the layout must not use it bare — a decode failure means we
// cannot reproduce the page's key and must fail open rather than 404.
export function decodeSlugOrNull(raw: string): string | null {
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}
