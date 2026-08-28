import { supabaseAdmin } from "@/lib/supabase"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import { normalizeBadgeKey } from "./normalize"

// ── BUDGET ──────────────────────────────────────────────────────────────────
// ⚠ This read sits on the BLOCKING shell of two pages — `/moment/[id]` (a bare
// sequential `await`, the LAST thing before the page returns JSX) and
// `/[collection]/edition/[slug]` (inside the shell `Promise.all`). On both, the
// route's `loading.tsx` fallback ("SCANNING THE MARKETPLACE…") is what a visitor
// stares at until this settles, so this call's budget IS a user-visible ceiling.
//
// It was already routed through `rpcWithRetry` for a wall-clock bound
// (2026-08-13) — but with no `timeoutMs`, so it silently inherited
// DEFAULT_RPC_TIMEOUT_MS = 45s. That made badge art the single widest window on
// a page whose every other read is bounded at 2.5–8s:
//
//   layout gate resolveMomentId ..... 8.0s  (withBoardBudget default)
//   fetchMomentDetail ............... 4.0s  (MOMENT_READ_TIMEOUT_MS)
//   the 8-RPC Promise.all ........... 4.0s  (MOMENT_READ_TIMEOUT_MS, shared)
//   resolveUsernames ................ 2.5s  (RESOLVE_USERNAMES_TIMEOUT_MS)
//   fetchBadgeArt ................... 45.0s <- this, 71% of a 63.5s worst case
//
// lib/moment-detail/fetchers.ts states the page ceiling as "4 + 4 = 8s" and
// warns: "Anyone making a second sequential await must redo that arithmetic."
// Two sequential awaits were added after it (resolveUsernames, this one) and the
// arithmetic was redone for the first but not the second.
//
// ⚠ SIZED OFF THE OBSERVED SUCCESS BAND, not off the config: pg_stat_statements
// over 39,286 production calls of get_badge_display_metadata reads mean 47ms,
// max 2,292ms. 4s clears the slowest recorded success by ~1.7x, so this cannot
// truncate a healthy run — it only cuts the tail where the DB is saturated and
// the read was never going to answer. Matches MOMENT_READ_TIMEOUT_MS by
// intent: badge art is worth exactly as much page-blocking time as the moment
// data itself, and no more.
//
// ⚠ The bound REJECTS (or returns an error envelope), which lands in the
// error/catch branches below that already return an empty map — the caller then
// falls back to a text pill, which is the designed degraded state. No new
// failure policy is introduced by bounding.
export const BADGE_ART_TIMEOUT_MS = 4_000

// Server-side resolver for real badge ARTWORK (the SVGs Trevor wants in place
// of ALL-CAPS text pills). get_badge_display_metadata returns
// { canonicalTitle: { icon_url, ... } } for the badges whose art exists
// (proxied via /api/badge-image). Returns a map of normalized-title -> icon_url
// so server components can render the image; badges with no art are absent and
// the caller falls back to a text pill. Client surfaces get the same data via
// the BadgeRow / BadgeIcon taxonomy hook. (2026-06-15)
//
// Pass `collectionId` to resolve collection-correct art: e.g. NFL All Day's
// "Rookie Year" / "Championship Year" badges share a title with Top Shot but
// have their own SVGs, so the lookup is collection-aware. Omit it (or pass null)
// for the Top Shot / collection-agnostic path. (2026-06-29)
export async function fetchBadgeArt(
  titles: string[],
  collectionId?: string | null,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unique = Array.from(new Set(titles.filter(Boolean)))
  if (unique.length === 0) return out
  try {
    // Via rpcWithRetry for its wall-clock bound: this runs inside the edition
    // page's BLOCKING shell Promise.all, where a bare .rpc() that never answers
    // parks the whole render on the loading skeleton. (2026-08-13)
    // The explicit budget is the point — see BADGE_ART_TIMEOUT_MS above; without
    // it this inherits 45s and the bound stops being a page-appropriate one.
    const { data, error } = await rpcWithRetry<any>(supabaseAdmin as never, "get_badge_display_metadata", {
      p_titles: unique,
      p_collection_id: collectionId ?? null,
    }, { timeoutMs: BADGE_ART_TIMEOUT_MS })
    if (error) {
      console.warn(`[badge-art] rpc: ${error.message}`)
      return out
    }
    if (data && typeof data === "object") {
      for (const [canonicalTitle, meta] of Object.entries(
        data as Record<string, { icon_url?: string | null }>,
      )) {
        const iconUrl = meta?.icon_url
        if (iconUrl) out.set(normalizeBadgeKey(canonicalTitle), iconUrl)
      }
    }
  } catch (err) {
    console.warn(`[badge-art] threw: ${err instanceof Error ? err.message : String(err)}`)
  }
  return out
}
