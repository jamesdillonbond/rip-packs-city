// lib/search/player-search-retry.ts
//
// #207, platform-wide (2026-10-22). A player search that reaches the database as
// `ilike '%typed%'` — PostgREST `.ilike("player_name", …)` or an RPC's `p_player`
// — is accent-SENSITIVE: "doncic" finds nothing for "Luka Dončić", "acuna" nothing
// for "Ronald Acuña Jr.". 194 Top Shot / All Day / Golazos / Candy / Panini player
// names carry a diacritic (measured 10-22), and people rarely type one.
//
// The rule every such surface follows, through this one helper:
//   - only an EMPTY answer is touched: a search that matched anything — or a read
//     that FAILED — is returned exactly as it was (a failure must never be
//     retried into an answer, nor an answer swapped for a guess);
//   - the typed text goes to `resolve_player_name` (accent-, alias- and
//     namesake-aware, every collection) and is retried ONCE, and only when the
//     resolver names exactly one person with one label (`singleRetryLabel`) —
//     ambiguity is never guessed ("vinicius" → two Golazos players → no retry);
//   - the swap is REPORTED (`playerResolved`), and the page says so
//     (components/filters/PlayerResolvedNote) — never a silent subject swap.
//
// The market and the Sniper resolve through their own catalog
// (lib/market/catalog-player.ts); the same contract.

import { resolvePlayerName, singleRetryLabel } from "@/lib/concierge/player-identity"

export type PlayerResolved = { from: string; to: string }

type Read<T> = { data: T[] | null; error: unknown }

/**
 * `first` is the ordinary search's result; `run(label)` re-runs the same read
 * with `label` in place of the typed text. A cross-collection board passes every
 * collection it spans: the retry happens only when they agree on ONE spelling.
 */
export async function retryEmptyPlayerSearch<T>(opts: {
  supabase: unknown
  collectionUuid: string | readonly string[] | null
  typed: string | null | undefined
  first: Read<T>
  run: (label: string) => PromiseLike<Read<T>>
}): Promise<Read<T> & { playerResolved: PlayerResolved | null }> {
  const { first } = opts
  const typed = (opts.typed ?? "").trim()
  const unchanged = { ...first, playerResolved: null }
  if (!typed || first.error || !Array.isArray(first.data) || first.data.length > 0) return unchanged
  const uuids = (Array.isArray(opts.collectionUuid) ? opts.collectionUuid : opts.collectionUuid ? [opts.collectionUuid] : []) as readonly string[]
  if (uuids.length === 0) return unchanged
  const labels = await Promise.all(uuids.map(async (u) => singleRetryLabel(await resolvePlayerName(opts.supabase, u, typed), typed)))
  const distinct = new Set(labels.filter((l): l is string => l !== null))
  if (distinct.size !== 1) return unchanged
  const [to] = distinct
  // The retry may only ever IMPROVE an answered empty: if it throws, the
  // original empty answer stands.
  let again: Read<T>
  try { again = await opts.run(to) } catch { return unchanged }
  if (again.error || !Array.isArray(again.data) || again.data.length === 0) return unchanged
  return { data: again.data, error: null, playerResolved: { from: typed, to } }
}

/**
 * Names a user TYPED that will later be compared for EQUALITY (a deal alert's
 * `player_names` matches `lower(player_name) = lower(x)` in
 * build_deal_alerts_for_subscription) — so "luka doncic" saved as typed would
 * never fire, silently. Each name becomes the resolver's single spelling when
 * every collection in scope that names someone agrees on one; anything else
 * (ambiguous, unknown, a failed read) keeps the typed text.
 */
export async function canonicalPlayerNames(
  supabase: unknown,
  names: readonly string[],
  collectionUuids: readonly string[],
): Promise<{ names: string[]; resolved: PlayerResolved[] }> {
  const resolved: PlayerResolved[] = []
  const out = await Promise.all(names.map(async (typed) => {
    const t = typed.trim()
    if (!t || collectionUuids.length === 0) return typed
    const labels = await Promise.all(collectionUuids.map(async (u) => singleRetryLabel(await resolvePlayerName(supabase, u, t), t)))
    const distinct = new Set(labels.filter((l): l is string => l !== null))
    if (distinct.size !== 1) return typed
    const [to] = distinct
    resolved.push({ from: t, to })
    return to
  }))
  return { names: out, resolved }
}
