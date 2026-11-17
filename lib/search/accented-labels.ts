// lib/search/accented-labels.ts
//
// #207 for site search's TEAM and SET arms (2026-10-23). rpc_search_catalog folds
// accents in its PLAYER arm only — the team and set arms match the raw query to
// keep their trigram indexes — so none of the 12 accented team / set labels was
// findable without the accent: "atletico" found no Atlético de Madrid team row,
// "clasico" no ElClásico set, "idolos" no Ídolos.
//
// Instead of slowing the hot path, /api/search keeps the (tiny) list of accented
// team and set labels — public.search_accented_labels(), read once an hour per
// instance — and, when a query matches one of them only accent-blind, re-runs the
// search with that exact label and merges in its team / set row.

import { matchRank, foldForMatch } from "@/lib/filter-match"
import { boundedRead } from "@/lib/api/bounded-read"
import { ilikeWouldMatch } from "@/lib/market/player-match"

export type AccentedLabel = { kind: string; label: string }

const TTL_MS = 60 * 60 * 1000
const MAX_MATCHES = 3
let memo: { at: number; labels: AccentedLabel[] } | null = null
// 2026-11-14: the read was unbounded and a failure was not remembered, so under DB slowness a search
// whose main query had already answered waited on this optional extra until the platform killed the
// function, and every request paid the failure again. Bounded, and a failure is not retried for a minute.
const READ_BUDGET_MS = 2_000
const FAILURE_BACKOFF_MS = 60_000
let failedAt = 0

type Rpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> }

/** The accented labels, memoized for an hour. A failed read returns [] and is NOT cached. */
export async function loadAccentedLabels(db: Rpc): Promise<AccentedLabel[]> {
  if (memo && Date.now() - memo.at < TTL_MS) return memo.labels
  if (Date.now() - failedAt < FAILURE_BACKOFF_MS) return []
  try {
    const { data, error } = await boundedRead(db.rpc("search_accented_labels", {}), "search/accented-labels", READ_BUDGET_MS)
    if (error || !Array.isArray(data)) {
      failedAt = Date.now()
      console.error("[search] accented labels unavailable — no accent-blind team/set hits", (error as { message?: string } | null)?.message ?? "bad payload")
      return []
    }
    const labels = (data as Array<Record<string, unknown>>)
      .filter((r) => typeof r.kind === "string" && typeof r.label === "string" && r.label !== "")
      .map((r) => ({ kind: r.kind as string, label: r.label as string }))
    memo = { at: Date.now(), labels }
    return labels
  } catch (e) {
    failedAt = Date.now()
    console.error("[search] accented labels threw", e instanceof Error ? e.message : e)
    return []
  }
}

/**
 * Labels the query matches ONLY once accents are ignored: every word matches
 * accent-blind, and at least one word would miss the database's raw ILIKE. A
 * label the raw search already finds is never re-run.
 */
export function accentOnlyLabelMatches(q: string, labels: readonly AccentedLabel[]): AccentedLabel[] {
  const words = foldForMatch(q).trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const rawWords = q.trim().split(/\s+/).filter(Boolean)
  return labels
    .filter((l) => matchRank(l.label, q) >= 0 && !rawWords.every((w) => ilikeWouldMatch(l.label, w)))
    .slice(0, MAX_MATCHES)
}

/** Test seam. */
export function _resetAccentedLabelsMemo() { memo = null }
