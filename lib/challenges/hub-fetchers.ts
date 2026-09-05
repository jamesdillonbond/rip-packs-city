// lib/challenges/hub-fetchers.ts
//
// The single read behind /[collection]/challenges.
//
// Extracted from `page.tsx` for the same two reasons as
// `lib/hot-floors/fetchers.ts`: the read was UNBOUNDED (a hang throws nothing,
// so the page's `try/catch` could not reach its own error branch and the
// document never completed), and `app/**/page.tsx` is measured by NEITHER
// coverage gate, so nothing pinned the honest-vs-empty distinction.
//
// ⚠ Named `hub-fetchers` rather than `fetchers` because `lib/challenges/`
// already holds `topshot-ingest.ts`; a bare `fetchers.ts` there would read as
// the ingest's data layer rather than the hub page's.
//
// ⚠ THE PAGE'S HONESTY BRANCH ALREADY EXISTED: "Couldn't load challenges right
// now" on `errored`, separately from the empty state. Only a read that SUCCEEDED
// may claim there are no active challenges.

import { supabaseAdmin } from "@/lib/supabase"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"

/**
 * ⚠ Heavier than it looks: `get_active_challenges` prices each challenge's
 * completion cost at the current floor and its reward as pack EV or moment FMV,
 * so it is an aggregate over the catalogue rather than a lookup. The page is
 * `revalidate`-cached, so a cold entry performs it inline.
 */
export const CHALLENGES_TIMEOUT_MS = 8_000

/**
 * ⚠ camelCase, not snake_case — the RPC returns a JSON payload the page consumes
 * verbatim, so these field names are the RPC's, not a table's. Copied from the
 * page rather than retyped: a "tidied" shape here would compile and render blanks.
 */
export interface ChallengeRow {
  challengeId: string
  slug: string
  name: string
  challengeType: string
  endsAt: string | null
  rewardKind: string | null
  rewardLabel: string | null
  totalRewardAllocation: number | null
  completedCount: number | null
  totalRequired: number
  missingCount: number
  unresolvedSlots?: number
  completionPct: number | null
  costToComplete: number | null
  rewardValue: number | null
  netEv: number | null
  worthIt: boolean | null
}

/**
 * ⚠ `ok` answers *did the READ succeed*, never *are there challenges*. Top Shot
 * genuinely runs none between events, and the page must keep being able to say
 * so.
 */
export interface ChallengesResult {
  challenges: ChallengeRow[]
  ok: boolean
}

/**
 * Whether the thing that FEEDS this table is still working.
 *
 * 🚨 THE THIRD STATE, AND THE READ CANNOT SEE IT. The page already separates
 * "the read failed" from "there are genuinely none" — which is the canon
 * correctly applied to the READ. But a read of a healthy table can succeed,
 * return zero active challenges, and still be reporting a dead SOURCE:
 *
 *   • `ingest-topshot-challenges` has returned HTTP 530 on EVERY run since
 *     2026-08-29 — `public-api.nbatopshot.com` is decommissioned. Last OK day:
 *     2026-08-28.
 *   • The only paths that can ADD a challenge are `upsert_challenge_from_gql`
 *     (fed by that ingest) and a manual `upsert_challenge`. Enumerated over
 *     `pg_proc`, because nothing in the repo writes the table directly.
 *   • ...and the table still LOOKS fresh: all 31 rows have an `updated_at`
 *     inside 7 days, because `refresh_challenge_costs` re-prices them on its
 *     own cadence. Freshness of the ROWS is not freshness of the FEED.
 *
 * The copy this gates used to promise *"When Top Shot runs a Set-Locking or
 * Crafting Challenge, it'll show up here"*. With the ingest dead that is a
 * forward-looking claim we cannot keep — the exact class the honesty canon
 * calls an empty state that CONCLUDES rather than reports.
 *
 * ⚠ `"unknown"` is a real third value, not a default. If the freshness read
 * itself fails we must neither keep the promise nor allege staleness, so the
 * page drops the promise and states only the fact. Omission understates, which
 * is the safe direction.
 */
export type ChallengeFeedState = "current" | "stale" | "unknown"

export interface ChallengeFeed {
  state: ChallengeFeedState
  /** The last day the ingest reported a success, `YYYY-MM-DD`, or null. */
  lastOkDay: string | null
}

/**
 * How long the daily challenge ingest may go without a success before the page
 * stops promising that new challenges will appear.
 *
 * ⚠ 3 days, not 1: the ingest is daily, so a single missed tick is ordinary
 * noise and a 1-day bar would flip the copy on every blip. Three consecutive
 * misses is a source that is down, not a source that hiccupped.
 */
export const CHALLENGE_FEED_STALE_DAYS = 3

export async function fetchActiveChallenges(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
  timeoutMs: number = CHALLENGES_TIMEOUT_MS,
): Promise<ChallengesResult> {
  try {
    const { data, error } = await withBoardBudget<{
      data: { challenges?: unknown } | null
      error: { message: string } | null
    }>(
      db.rpc("get_active_challenges", { p_wallet: null }),
      "challenges",
      timeoutMs,
      "collection/",
    )
    if (error) {
      console.error("[challenges] read error:", error.message)
      return { challenges: [], ok: false }
    }
    // ⚠ A non-array payload is a shape change, not an empty result — see the
    // same note in lib/hot-floors/fetchers.ts.
    const rows = data?.challenges
    if (rows != null && !Array.isArray(rows)) {
      console.error("[challenges] unexpected payload shape")
      return { challenges: [], ok: false }
    }
    return { challenges: (rows ?? []) as ChallengeRow[], ok: true }
  } catch (e) {
    console.error("[challenges] read bound:", e instanceof Error ? e.message : e)
    return { challenges: [], ok: false }
  }
}

/**
 * Read the challenge ingest's last successful day.
 *
 * ⚠ `pipeline_runs_daily`, NOT `pipeline_runs` — the latter retains ~73 h, and
 * the last success here is 2026-08-28, so the live table would report "never
 * succeeded" for a pipeline that worked fine a fortnight ago. The daily rollup
 * is indefinite. ⚠ Its column is `pipeline`, not `pipeline_name`.
 *
 * ⚠ Bounded like every other read on this page: `app/**` server pages hold a
 * ban at zero for unbounded reads (`check-unbounded-server-reads.mjs`), and a
 * freshness probe that hangs would take the page down to protect a caption.
 * On any failure this returns `"unknown"` — never `"current"`, which would
 * restore the promise out of a failed read.
 */
export async function fetchChallengeFeed(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
  timeoutMs: number = CHALLENGES_TIMEOUT_MS,
  now: Date = new Date(),
): Promise<ChallengeFeed> {
  try {
    const { data, error } = await withBoardBudget<{
      data: Array<{ day: string }> | null
      error: { message: string } | null
    }>(
      db
        .from("pipeline_runs_daily")
        .select("day")
        .eq("pipeline", "ingest-topshot-challenges")
        .gt("ok_count", 0)
        .order("day", { ascending: false })
        .limit(1),
      "challenge-feed",
      timeoutMs,
      "collection/",
    )
    if (error) {
      console.error("[challenges] feed freshness read error:", error.message)
      return { state: "unknown", lastOkDay: null }
    }
    const lastOkDay = Array.isArray(data) && data[0]?.day ? String(data[0].day) : null
    // A pipeline that has NEVER succeeded is not "current" — it is the strongest
    // form of stale, and returning "unknown" here would hide a permanently dead
    // feed behind the softest copy.
    if (!lastOkDay) return { state: "stale", lastOkDay: null }
    const ageMs = now.getTime() - new Date(`${lastOkDay}T00:00:00Z`).getTime()
    const ageDays = ageMs / 86_400_000
    return {
      state: ageDays > CHALLENGE_FEED_STALE_DAYS ? "stale" : "current",
      lastOkDay,
    }
  } catch (e) {
    console.error("[challenges] feed freshness bound:", e instanceof Error ? e.message : e)
    return { state: "unknown", lastOkDay: null }
  }
}
