// lib/concierge/allday-boards.ts
//
// The concierge's NFL All Day reads — All Day ↔ Top Shot parity, 2026-10-26.
//
// Before this file, an All Day question to the concierge fell into the SUBSTITUTION hole
// (CLAUDE.md "SUBSTITUTION is the face where nothing fails"): get_hot_floors, get_edition_sweep,
// get_special_serial_owners and search_serial_deals read Top Shot tables unconditionally, so on an All
// Day page they answered about Top Shot; and get_badge_info told every reader moment badges are Top Shot
// only, which has been false since allday-badge-ingest began writing badge_editions.set_play_tags.
//
// ── HONESTY ────────────────────────────────────────────────────────────────
//   · A failed read is an ERROR payload, never an empty board (three states).
//   · Sweepers are COUNTED, never named (the board page's rule).
//   · No FMV confidence field reaches the model (concierge rule 3).
//   · RPC is read-only: links to RPC pages; never an offer to buy.

import { textIncludes } from "@/lib/filter-match"

export const ALLDAY_COLLECTION_UUID = "dee28451-5d62-409e-a1ad-a83f763ac070"
export const ALLDAY_URL_SLUG = "nfl-all-day"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

/** Either spelling convention (`nfl-all-day` / `nfl_all_day`), case-blind. */
export function isAllDaySlug(slug: string | null | undefined): boolean {
  return (slug ?? "").trim().toLowerCase().replace(/_/g, "-") === ALLDAY_URL_SLUG
}

export function allDayNotApplicable(tool: string, why: string, instead?: string): string {
  return JSON.stringify({
    status: "not_applicable",
    collection: ALLDAY_URL_SLUG,
    tool,
    message: `${why}${instead ? ` ${instead}` : ""} Do not answer with Top Shot data on an All Day question.`,
  })
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// ── Hot floors (get_hot_floors on All Day) ─────────────────────────────────
// get_allday_hot_floors: one collector taking 3+ copies of an edition with no gap over 60 min, over
// sales_market (pack buybacks excluded). All Day sales carry no Quick-Buy proposer, so this is not Top
// Shot's Quick-Buy test, and the note says so.
export async function readAllDayHotFloorsForConcierge(db: Db, base: string, opts: { days: number; limit: number }): Promise<string> {
  const days = Math.min(Math.max(Math.trunc(opts.days) || 7, 1), 30)
  const limit = Math.min(Math.max(Math.trunc(opts.limit) || 15, 1), 40)
  try {
    const { data, error } = await db.rpc("get_allday_hot_floors", { p_days: days })
    if (error) return JSON.stringify({ status: "error", collection: ALLDAY_URL_SLUG, message: `All Day hot floors read failed: ${error.message ?? "unknown error"}` })
    const rows = data?.editions
    if (!Array.isArray(rows)) return JSON.stringify({ status: "error", collection: ALLDAY_URL_SLUG, message: "All Day hot floors returned an unexpected shape; this says nothing about the market." })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eds = rows.slice(0, limit).map((e: any) => {
      const swept = num(e.swept_sales) ?? 0
      const spend = num(e.swept_spend)
      return {
        edition: e.external_id,
        player: e.player_name,
        set: e.set_name,
        tier: e.tier,
        circulation: num(e.circulation_count),
        sweep_buyers: num(e.sweep_buyers),
        swept_sales: swept,
        avg_paid_usd: swept > 0 && spend != null ? Math.round((spend / swept) * 100) / 100 : null,
        floor_ask_usd: num(e.floor_ask),
        floor_ask_last_checked_at: e.floor_ask_verified_at ?? null,
        fmv_usd: num(e.fmv_usd),
        last_swept_at: e.last_swept_at ?? null,
        edition_url: e.external_id ? `${base}/${ALLDAY_URL_SLUG}/edition/${encodeURIComponent(String(e.external_id))}` : null,
      }
    })
    return JSON.stringify({
      status: "ok",
      collection: ALLDAY_URL_SLUG,
      window_days: days,
      count: eds.length,
      hot_floors: eds,
      board_url: `${base}/${ALLDAY_URL_SLUG}/hot-floors`,
      note: "All Day editions being swept: one collector buying 3+ copies with no gap over 60 minutes, ranked by distinct sweepers. All Day sales record no Quick-Buy path, so this is not Top Shot's Quick-Buy measure — say 'bought in bulk', not 'Quick Buy'. Collectors are counted, never named. floor_ask_usd is null when no open ask is indexed; floor_ask_last_checked_at is when that ask was last verified on chain.",
    })
  } catch (err) {
    return JSON.stringify({ status: "error", collection: ALLDAY_URL_SLUG, message: `All Day hot floors read failed: ${err instanceof Error ? err.message : String(err)}` })
  }
}

// ── Badges (get_badge_info on All Day) ─────────────────────────────────────
// get_allday_badge_counts: every badge title in badge_editions.set_play_tags with edition counts (total
// and per tier), derived from the data. With a player, the player's All Day editions carrying the
// matched badge(s) — read by containment on set_play_tags, the same shape the Top Shot arm uses on
// play_tags.

export const ALLDAY_BADGE_COVERAGE_NOTE =
  "All Day moment badges come from badge_editions.set_play_tags (allday-badge-ingest): every badge title All Day uses appears in this answer with its live edition count. All Day badges are not the same list as Top Shot's — never carry a Top Shot badge name or count over."

function normBadgeKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

export async function readAllDayBadgesForConcierge(
  db: Db,
  base: string,
  opts: { badge: string; player: string | null; playerLabels: string[] | null; playerId: string | null },
): Promise<string> {
  try {
    const { data, error } = await db.rpc("get_allday_badge_counts")
    if (error) return JSON.stringify({ status: "error", collection: ALLDAY_URL_SLUG, message: `All Day badge census read failed: ${error.message ?? "unknown error"}. This says nothing about which badges exist.` })
    const badges = data?.badges
    if (!Array.isArray(badges)) return JSON.stringify({ status: "error", collection: ALLDAY_URL_SLUG, message: "All Day badge census returned an unexpected shape; this says nothing about which badges exist." })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all = badges.map((b: any) => ({ title: String(b.title), editions: num(b.editions), by_tier: b.by_tier ?? null }))
    const want = normBadgeKey(opts.badge)
    if (!want) {
      return JSON.stringify({
        status: "ok",
        mode: "list",
        collection: ALLDAY_URL_SLUG,
        editions_indexed: num(data?.editions_indexed),
        badges: all.map((b) => ({ title: b.title, editions_tagged: b.editions })),
        note: "Every All Day moment badge with how many editions carry it (live). For one badge's per-tier split or a player's badged editions, call again with that badge.",
        coverage_note: ALLDAY_BADGE_COVERAGE_NOTE,
      })
    }
    const matches = all.filter((b) => {
      const k = normBadgeKey(b.title)
      return k === want || k.includes(want) || (k.length >= 4 && want.includes(k))
    })
    if (matches.length === 0) {
      return JSON.stringify({
        status: "no_results",
        mode: "detail",
        collection: ALLDAY_URL_SLUG,
        query: opts.badge,
        all_day_badges: all.map((b) => b.title),
        message: "No All Day badge matches that name. These are the badges All Day uses; it may be a Top Shot badge (ask on a Top Shot page) or a set theme rather than a badge.",
        coverage_note: ALLDAY_BADGE_COVERAGE_NOTE,
      })
    }
    let playerEditions: unknown = null
    if (opts.player) {
      const titles = new Set(matches.map((m) => m.title))
      let q = db
        .from("badge_editions")
        .select("external_id, player_name, set_name, tier, circulation_count, set_play_tags")
        .eq("collection_id", ALLDAY_COLLECTION_UUID)
      q = opts.playerId ? q.eq("player_id", opts.playerId) : opts.playerLabels ? q.in("player_name", opts.playerLabels) : q.ilike("player_name", `%${opts.player}%`)
      const { data: pe, error: peErr } = await q.order("external_id", { ascending: true }).limit(400)
      if (peErr) {
        playerEditions = { status: "error", message: `player badge lookup failed: ${peErr.message ?? "unknown error"}` }
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows = ((pe ?? []) as any[])
          .map((r) => ({
            r,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            badges: Array.isArray(r.set_play_tags) ? (r.set_play_tags as any[]).map((t) => String(t?.title ?? "")).filter(Boolean) : [],
          }))
          .filter(({ badges }) => badges.some((t) => titles.has(t)))
          .map(({ r, badges }) => ({
            editionKey: r.external_id,
            player: r.player_name,
            set: r.set_name,
            tier: r.tier,
            circulation: num(r.circulation_count),
            badges,
            edition_url: `${base}/${ALLDAY_URL_SLUG}/edition/${encodeURIComponent(String(r.external_id))}`,
          }))
        playerEditions = { status: rows.length ? "ok" : "no_results", player_query: opts.player, total: rows.length, editions: rows.slice(0, 40) }
      }
    }
    return JSON.stringify({
      status: "ok",
      mode: "detail",
      collection: ALLDAY_URL_SLUG,
      query: opts.badge,
      matches: matches.map((m) => ({ title: m.title, all_day_editions_tagged: m.editions, by_tier: m.by_tier })),
      ...(playerEditions ? { player_editions: playerEditions } : {}),
      count_note: "Live counts of All Day editions carrying that badge, total and per tier.",
      premium_note: "This does NOT price a badge. To discuss a premium, price badged vs. unbadged editions of the same set and tier with get_fmv / get_player_editions — never from memory.",
      coverage_note: ALLDAY_BADGE_COVERAGE_NOTE,
    })
  } catch (err) {
    return JSON.stringify({ status: "error", collection: ALLDAY_URL_SLUG, message: `All Day badge census read failed: ${err instanceof Error ? err.message : String(err)}` })
  }
}

// ── Set completion (get_set_completion_cost / get_cheapest_sets_to_complete on All Day) ──
// /api/allday-set-progress is the All Day Sets tab's backend (get_allday_set_progress). ⚠ Its
// `totalMissingCost` is the SUM OF FMV of the missing editions, not live asks — and an edition with no
// FMV adds $0 — so it is presented as a value at FMV and a lower bound, never as a cost at the floor.

export const ALLDAY_NEEDS_FLOW_WALLET = JSON.stringify({
  status: "need_input",
  collection: ALLDAY_URL_SLUG,
  message: "All Day set progress needs the collector's Flow wallet address (0x + 16 hex characters, the Dapper wallet). Ask for it; do not guess one from a username.",
})

export function isFlowAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{16}$/.test(s.trim())
}

export async function readAllDaySetCompletionForConcierge(
  base: string,
  wallet: string,
  opts: { setName?: string | null; cheapestFirst?: boolean; limit?: number } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const failed = JSON.stringify({ status: "error", collection: ALLDAY_URL_SLUG, message: "The All Day set read failed — say the check failed; never say this wallet has no set progress." })
  try {
    const res = await fetchImpl(`${base}/api/allday-set-progress?wallet=${encodeURIComponent(wallet)}`, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return failed
    const body = (await res.json()) as Record<string, unknown>
    const all = Array.isArray(body.sets) ? (body.sets as Record<string, unknown>[]) : null
    if (!all) return failed
    const want = String(opts.setName ?? "").trim().toLowerCase()
    let sets = want ? all.filter((s) => textIncludes(String(s.setName ?? ""), want)) : all
    if (opts.cheapestFirst) {
      sets = sets
        .filter((s) => (num(s.missingCount) ?? 0) > 0 && (num(s.ownedCount) ?? 0) > 0)
        .sort((a, b) => (num(a.totalMissingCost) ?? Infinity) - (num(b.totalMissingCost) ?? Infinity))
    }
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 8) || 8, 1), 25)
    const tabUrl = `${base}/${ALLDAY_URL_SLUG}/sets?wallet=${encodeURIComponent(wallet)}`
    if (want && sets.length === 0) {
      return JSON.stringify({
        status: "no_results",
        collection: ALLDAY_URL_SLUG,
        wallet,
        set_query: opts.setName,
        message: "No All Day set name matches that. Ask which set they mean, or link the Sets tab.",
        sets_tab_url: tabUrl,
      })
    }
    return JSON.stringify({
      status: "ok",
      collection: ALLDAY_URL_SLUG,
      wallet,
      total_sets: num(body.totalSets),
      complete_sets: num(body.completeSets),
      sets: sets.slice(0, limit).map((s) => ({
        set: s.setName,
        editions_total: num(s.totalEditions),
        editions_owned: num(s.ownedCount),
        editions_missing: num(s.missingCount),
        completion_pct: num(s.completionPct),
        missing_value_at_fmv_usd: num(s.totalMissingCost),
        highest_fmv_missing: Array.isArray(s.missing)
          ? (s.missing as Record<string, unknown>[]).slice(0, 5).map((m) => ({ player: m.playerName ?? null, tier: m.tier ?? null, fmv_usd: num(m.fmv) }))
          : [],
      })),
      sets_tab_url: tabUrl,
      how_to_read:
        "missing_value_at_fmv_usd is the SUM OF FMV of the editions this wallet is missing — not live asks, and an edition with no FMV adds nothing, so it is a lower bound. Never call it the cost to buy at the floor; for a live price on a missing edition use get_edition_listings. Quote the numbers; never call a set cheap or a good buy.",
      note: "RPC is read-only — link the Sets tab; never offer to buy.",
    })
  } catch {
    return failed
  }
}
