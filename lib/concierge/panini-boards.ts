// lib/concierge/panini-boards.ts
//
// The concierge's reads of two Panini boards it could not reach before 2026-10-19:
//   · the Panini PACK MARKET (/api/panini-pack-market, the Packs tab's backend) — 351 packs,
//     a few dozen modelled. The route's payload is far too large to forward whole (500 history
//     rows), so it is trimmed here to one compact row per pack.
//   · the Panini PREMIUMS boards (/insights/panini-premiums, lib/insights/panini-premiums.ts).
//
// ── HONESTY ────────────────────────────────────────────────────────────────
//   · A failed read is an ERROR payload, never an empty board (three states: failed · empty · rows).
//   · A pack's EV is a model over a LISTING-GATED index, and its mean is carried by a few chase
//     cards (the 10-18 re-measure: four LOW chase editions add ~$33/pack). So every row carries a
//     `rip_verdict` computed HERE, and the model is told to quote it: a positive mean edge whose
//     typical pull (or simulated median pack) is under cost is `positive_on_mean_only`, never "+EV".
//     Only `typical_pack_beats_cost` (simulated P(pull ≥ cost) ≥ 50 %) may be described as a
//     pack that usually pays — the same gate the Packs tab applies (panini.md Next 4).
//   · FMV CONFIDENCE IS INTERNAL (CLAUDE.md concierge rule 3): the premiums rows drop the
//     *_confidence fields before they reach the model.
//
// ── DEALS (added the same evening) ──────────────────────────────────────────
// search_live_deals on a Panini page called /api/sniper-feed, which answers an EMPTY board
// for every collection it has no source for, then fell back to `cached_listings`, which
// holds no Panini rows: "no deals" while the Sniper tab showed hundreds. Panini's deals are
// the hourly `panini-boards` snapshot (`deals_all`) the Sniper tab is seeded from. This
// reads that SNAPSHOT ONLY, at any age, stamped with its age: the live rebuild is ~138k
// buffers and must not run per chat message (lib/insights/panini-more-boards.ts).

import { fetchPaniniPremiums } from "@/lib/insights/panini-premiums"
import { readBoardSnapshot } from "@/lib/insights/board-cache"
import { editionKeyOfSku } from "@/lib/panini/overview-feeds"
import { paniniEditionUrl } from "@/lib/panini/edition-url"
import { textIncludes } from "@/lib/filter-match"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

/** At or above this simulated P(pull ≥ cost) a pack may be called one that usually pays. */
export const PANINI_PACK_TYPICAL_BEATS_COST = 0.5

export type PaniniRipVerdict =
  | "not_modeled"
  | "no_price"
  | "no_edge"
  | "positive_on_mean_only"
  | "typical_pack_beats_cost"

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Classify one pack-market product. Exported for the test. */
export function paniniRipVerdict(p: {
  evModeled?: unknown
  costUsd?: unknown
  netRipEdgeUsd?: unknown
  typicalEvUsd?: unknown
  sim?: { pBeatCost?: unknown } | null
}): PaniniRipVerdict {
  if (p.evModeled !== true) return "not_modeled"
  const cost = num(p.costUsd)
  const edge = num(p.netRipEdgeUsd)
  if (cost === null || edge === null) return "no_price"
  const pBeat = num(p.sim?.pBeatCost)
  if (pBeat !== null && pBeat >= PANINI_PACK_TYPICAL_BEATS_COST) return "typical_pack_beats_cost"
  if (edge <= 0) return "no_edge"
  // A positive mean edge. Without a simulation, the typical pull stands in for the median pack;
  // with neither, the edge is still only a mean.
  const typical = num(p.typicalEvUsd)
  if (pBeat === null && typical !== null && typical >= cost) return "typical_pack_beats_cost"
  return "positive_on_mean_only"
}

export async function readPaniniPackMarketForConcierge(base: string, limit: number): Promise<string> {
  try {
    const res = await fetch(`${base}/api/panini-pack-market`, { signal: AbortSignal.timeout(9000) })
    if (!res.ok) {
      return JSON.stringify({
        status: "error",
        http_status: res.status,
        message: "The Panini pack market read failed — say the check failed; do NOT say there are no packs.",
      })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json()
    if (!Array.isArray(json?.products)) {
      return JSON.stringify({ status: "error", message: "The Panini pack market returned an unreadable payload — say the check failed." })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all = json.products as any[]
    // The route sorts modelled packs first; keep that order so a short limit shows the priced ones.
    const rows = all.slice(0, limit).map((p) => {
      const verdict = paniniRipVerdict(p)
      const modeled = p.evModeled === true
      return {
        pack: p.name ?? p.label ?? p.id,
        product: p.productName ?? null,
        sport: p.sport ?? null,
        pack_type: p.packType ?? null,
        cost_usd: num(p.costUsd),
        // floor = a live lowest ask; avg_sale = an average sale (not buyable at); primary = Panini's drop price.
        cost_basis: p.costBasis ?? null,
        packs_remaining: num(p.packsRemaining),
        ev_modeled: modeled,
        typical_pull_usd: modeled ? num(p.typicalEvUsd) : null,
        mean_ev_usd: modeled ? num(p.actualEvUsd) : null,
        net_edge_on_mean_usd: modeled ? num(p.netRipEdgeUsd) : null,
        simulated_median_pack_usd: num(p.sim?.medianPullUsd),
        simulated_p_pull_beats_cost: num(p.sim?.pBeatCost),
        rip_verdict: verdict,
        model_note: p.modelNote ?? null,
        stats_updated_at: p.updatedAt ?? null,
        stats_stale: p.stale === true,
        // The pack's page on Panini's own marketplace (the route passes only that host).
        panini_url: typeof p.marketUrl === "string" ? p.marketUrl : null,
      }
    })
    return JSON.stringify({
      status: "ok",
      board_url: `${base}/panini-blockchain/packs`,
      total_packs: all.length,
      modeled_packs: all.filter((p) => p.evModeled === true).length,
      count: rows.length,
      rows,
      coverage_note:
        "Pack EV is modelled over a listing-fed index (Panini publishes no checklist), so it is a floor, not a census. " +
        "Lead with the typical pull / simulated median pack; the mean is carried by a few chase cards. " +
        "rip_verdict is authoritative: never call a pack +EV, profitable or worth ripping unless it reads typical_pack_beats_cost; " +
        "positive_on_mean_only means most packs return less than they cost. ev_modeled=false means NOT MODELLED — never $0. " +
        "A stats_stale price is older than 24 h — say so when you quote it.",
      coverage: json.coverage ?? null,
      coverage_error: json.coverage_error === true,
    })
  } catch {
    return JSON.stringify({ status: "error", message: "The Panini pack market read failed — say the check failed; do NOT say there are no packs." })
  }
}

export async function readPaniniPremiumsForConcierge(db: Db, base: string, limit: number): Promise<string> {
  try {
    const board = await fetchPaniniPremiums(db)
    return JSON.stringify({
      status: "ok",
      board_url: `${base}/insights/panini-premiums`,
      parallels: board.parallels.slice(0, limit).map((r) => ({
        player: r.player_name,
        product: r.product_name,
        sport: r.sport,
        parallel: r.parallel,
        mint_cap: r.mint_cap,
        parallel_fmv_usd: r.parallel_fmv_usd,
        base_parallel: r.base_parallel,
        base_mint_cap: r.base_mint_cap,
        base_fmv_usd: r.base_fmv_usd,
        premium_mult: r.premium_mult,
        edition_url: `${base}/panini-blockchain/edition/${encodeURIComponent(r.external_id)}`,
      })),
      parallels_total: board.parallels.length,
      parallels_capped: board.parallelsCapped,
      serials: board.serials.slice(0, limit).map((r) => ({
        player: r.player_name,
        product: r.product_name,
        sport: r.sport,
        parallel: r.parallel,
        serial_number: r.serial_number,
        mint_cap: r.mint_cap,
        sale_usd: r.sale_usd,
        sold_at: r.sold_at,
        edition_median_usd: r.edition_median_usd,
        edition_sales_n: r.edition_sales_n,
        premium_mult: r.premium_mult,
        edition_url: `${base}/panini-blockchain/edition/${encodeURIComponent(r.external_id)}`,
      })),
      serials_total: board.serials.length,
      serials_capped: board.serialsCapped,
      note:
        "parallels: a numbered parallel's FMV over the same player's most common base parallel in the same product (only well-supported prices, premium ≥ 1.5×). " +
        "serials: real sales of an edition's #1 or perfect-mint serial at ≥ 2× the median of its other 90-day sales. Listing-fed index — a floor, not a census.",
    })
  } catch {
    return JSON.stringify({ status: "error", message: "The Panini premiums read failed — say the check failed; do NOT say there are no premiums." })
  }
}

/** The deal-basis value the board uses for a deal its recent sales also back. */
const DEAL_BACKED = "fmv_and_recent_sales"
/** Past this age the snapshot is called stale to the model (three missed hourly warms). */
export const PANINI_DEALS_STALE_HOURS = 3

export interface PaniniDealFilters {
  /** 2026-10-25: edition keys of one franchise (panini_edition_team_keys) — a team filter. */
  editionKeys?: Set<string> | null
  team?: string | null
  /** A typed team: resolved here through paniniTeamEditionKeys (needs `db`). */
  teamQuery?: unknown
  db?: Db
  player?: unknown
  setName?: unknown
  sport?: unknown
  maxPrice?: unknown
  minDiscount?: unknown
  limit?: unknown
}

export async function readPaniniDealsForConcierge(
  base: string,
  f: PaniniDealFilters,
  read: typeof readBoardSnapshot = readBoardSnapshot,
): Promise<string> {
  const failed = JSON.stringify({
    status: "error",
    message: "The Panini deal board could not be read — say the check failed and link the Sniper tab; do NOT say there are no deals.",
    sniper_url: `${base}/panini-blockchain/sniper`,
  })
  if (typeof f.teamQuery === "string" && f.teamQuery.trim() && f.db) {
    const tk = await paniniTeamEditionKeys(f.db, f.teamQuery)
    if (tk.status === "ambiguous") return JSON.stringify({ status: "ambiguous", candidates: tk.candidates, message: "More than one franchise matches — ask which, then call again with its full name." })
    if (tk.status === "none") return JSON.stringify({ status: "no_results", message: `No NBA, WNBA, NFL or MLB team matches "${f.teamQuery}". Offer a player or sport filter.` })
    if (tk.status === "none_placed_yet") return JSON.stringify({ status: "none_placed_yet", team: tk.team, message: "RPC has not placed any Panini card on this team yet — say exactly that, never that there are no deals for the team; offer a player filter." })
    if (tk.status !== "ok") return JSON.stringify({ status: "error", message: "The Panini team lookup failed — say the check failed; do NOT say there are no deals. Offer a player filter or link /panini-blockchain/sniper." })
    f = { ...f, editionKeys: tk.keys, team: tk.team }
  }
  const snap = await read("panini-boards")
  if (!snap) return failed
  const p = snap.payload
  const allProducts = Array.isArray(p.deals_all)
  const raw = allProducts ? p.deals_all : p.deals
  if (!Array.isArray(raw) || (allProducts ? p.deals_all_error === true : p.deals_error === true)) return failed

  const lower = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null)
  const player = lower(f.player)
  const set = lower(f.setName)
  const sport = lower(f.sport)
  const maxPrice = num(f.maxPrice)
  // The board's discount_pct is a PERCENT (e.g. 42); a model passing 0.3 means 30 %.
  const md = num(f.minDiscount)
  const minDiscount = md === null ? null : md > 0 && md < 1 ? md * 100 : md
  const limit = Math.min(Math.max(Math.trunc(num(f.limit) ?? 5) || 5, 1), 15)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (raw as any[]).filter((r) => {
    if (!r || typeof r !== "object") return false
    if (f.editionKeys) {
      const ek = editionKeyOfSku(r.sku)
      if (!ek || !f.editionKeys.has(ek)) return false
    }
    if (player && !textIncludes(String(r.player_name ?? ""), player)) return false
    if (set && !textIncludes(`${r.product_name ?? ""} ${r.parallel ?? ""}`, set)) return false
    if (sport && String(r.sport ?? "").toLowerCase() !== sport) return false
    const ask = num(r.ask_usd)
    if (ask === null || ask <= 0) return false
    if (maxPrice !== null && ask > maxPrice) return false
    if (minDiscount !== null && (num(r.discount_pct) ?? 0) < minDiscount) return false
    return true
  })
  // Sale-backed deals lead (the Sniper tab's order), then the deepest discount.
  rows.sort((a, b) =>
    Number(b.deal_basis === DEAL_BACKED) - Number(a.deal_basis === DEAL_BACKED) ||
    (num(b.discount_pct) ?? 0) - (num(a.discount_pct) ?? 0) ||
    String(a.sku).localeCompare(String(b.sku)))

  const ageHours = Math.round((snap.ageMs / 3_600_000) * 10) / 10
  return JSON.stringify({
    status: rows.length ? "ok" : "no_matching_deals",
    scope: allProducts ? "every walked Panini product" : "2026 Prizm World Cup only (older snapshot)",
    ...(f.team ? { team: f.team, team_note: "Team = the cards RPC's Panini team map places on this franchise (a partial floor); a deal on an unplaced card is not shown." } : {}),
    board_total: raw.length,
    board_capped: allProducts ? p.deals_all_capped === true : p.deals_capped === true,
    matched: rows.length,
    results: rows.slice(0, limit).map((r) => {
      const ek = editionKeyOfSku(r.sku)
      return {
        player: r.player_name ?? null,
        product: r.product_name ?? null,
        sport: r.sport ?? null,
        parallel: r.parallel ?? null,
        serial: num(r.serial_number),
        mint_cap: num(r.mint_cap),
        ask_usd: num(r.ask_usd),
        fmv_usd: num(r.fmv_usd),
        discount_pct: num(r.discount_pct),
        est_edge_before_fees_usd: num(r.est_profit_usd),
        last_sale_usd: num(r.last_sale_usd),
        recent_sales_median_usd: num(r.recent_sales_median_usd),
        recent_sales_30d: num(r.recent_sales_n),
        backed_by_recent_sales: r.deal_basis === DEAL_BACKED,
        special_serial: r.special_flag ?? null,
        ask_seen_at: r.ask_confirmed_at ?? null,
        edition_url: ek ? `${base}/panini-blockchain/edition/${encodeURIComponent(ek)}` : null,
        panini_url: paniniEditionUrl(ek),
      }
    }),
    snapshot_refreshed_at: snap.refreshedAt,
    snapshot_age_hours: ageHours,
    snapshot_stale: ageHours > PANINI_DEALS_STALE_HOURS,
    sniper_url: `${base}/panini-blockchain/sniper`,
    note:
      "Discounted Panini asks vs RPC FMV, from the hourly deal snapshot behind the Sniper tab. Lead with backed_by_recent_sales deals; " +
      "a deal NOT backed by recent sales rests on FMV alone and you must say so. Asks are as of ask_seen_at and may be gone — " +
      "send the user to panini_url to check. no_matching_deals means no DISCOUNTED ask matched the filters, never that nothing is listed. " +
      "Panini's index is listing-fed (a floor, not a census). RPC does not buy or sell.",
  })
}

// ── COLLECTION BY USERNAME (added the same evening) ──────────────────────────
// check_wallet resolved any non-address input as a TOP SHOT username, so on a Panini
// page a Panini handle that also exists on Top Shot came back as some Top Shot
// collector's Flow portfolio — a substitution (another person's holdings under this
// name). A Panini owner is a Panini USERNAME; this reads the Collection tab's own
// backend (/api/panini-collection: cards seen under the name + the profile walk).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function topCards(cards: any[], n: number) {
  return [...cards]
    .filter((c) => c && typeof c === "object")
    .sort((a, b) => (num(b.fmvUsd) ?? -1) - (num(a.fmvUsd) ?? -1))
    .slice(0, n)
    .map((c) => ({
      player: c.playerName ?? null,
      set: c.setName ?? null,
      serial: num(c.serial),
      mint_cap: num(c.mintCap),
      fmv_usd: num(c.fmvUsd),
      listed_now_at_usd: c.isListed === true ? num(c.askUsd) : null,
      special_serial: Array.isArray(c.flags) && c.flags.length ? c.flags.join(", ") : null,
      edition_url: typeof c.editionKey === "string" && c.catalogued === true
        ? `/panini-blockchain/edition/${encodeURIComponent(c.editionKey)}`
        : null,
    }))
}

export async function readPaniniCollectionForConcierge(base: string, username: string): Promise<string> {
  const failed = (message: string) => JSON.stringify({ status: "error", message })
  try {
    const res = await fetch(`${base}/api/panini-collection?username=${encodeURIComponent(username)}`, { signal: AbortSignal.timeout(10000) })
    if (res.status === 400) {
      return JSON.stringify({ status: "bad_username", message: "That doesn't look like a Panini username (2–16 letters, numbers, . _ -). Ask the user to check it." })
    }
    if (!res.ok) return failed("The Panini collection read failed — say the check failed; never say this collector holds nothing.")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j: any = await res.json()
    if (!j || typeof j.cardsSeen !== "number") return failed("The Panini collection read returned an unreadable payload — say the check failed.")
    const profile = j.profile ?? null
    const walked = !!profile?.walk
    const tabUrl = `${base}/panini-blockchain/collection?username=${encodeURIComponent(j.username ?? username)}`
    const withBase = (rows: ReturnType<typeof topCards>) => rows.map((r) => ({ ...r, edition_url: r.edition_url ? `${base}${r.edition_url}` : null }))
    return JSON.stringify({
      status: walked || j.cardsSeen > 0 ? "ok" : "not_seen",
      username: j.username ?? username,
      collection_tab_url: tabUrl,
      // The PROFILE walk is the whole public collection as of that walk; null = never walked.
      profile_walk: walked
        ? {
            last_walk_at: profile.walk.lastWalkAt ?? null,
            profile_state: profile.walk.profileState ?? null,
            cards_held: num(profile.cardsHeld),
            editions: num(profile.editions),
            listed_now: num(profile.listedNow),
            special_serials: num(profile.specialSerials),
            fmv_held_usd: num(profile.fmvHeldUsd),
            fmv_priced_cards: num(profile.fmvPricedCards),
            top_cards: withBase(topCards(Array.isArray(profile.cards) ? profile.cards : [], 5)),
          }
        : null,
      // Cards RPC's marketplace walk has SEEN under this name — not a collection total.
      seen_on_marketplace: {
        cards_seen: j.cardsSeen,
        listed_now: num(j.listedNow),
        editions: num(j.editions),
        special_serials: num(j.specialSerials),
        fmv_seen_usd: num(j.fmvSeenUsd),
        fmv_priced_cards: num(j.fmvPricedCards),
        last_seen_at: j.lastSeenAt ?? null,
        top_cards: walked ? [] : withBase(topCards(Array.isArray(j.cards) ? j.cards : [], 5)),
      },
      note:
        "A Panini owner is a Panini USERNAME, not a wallet, and is unrelated to any Top Shot account of the same name. " +
        "profile_walk (when present) is the whole public profile as of last_walk_at; otherwise only seen_on_marketplace exists, " +
        "which is the cards RPC's walk has seen under this name — never call it their full collection. " +
        "status not_seen means RPC has not seen this username — NOT that they hold nothing. FMV totals cover fmv_priced_cards only. " +
        "Link collection_tab_url.",
    })
  } catch {
    return failed("The Panini collection read failed — say the check failed; never say this collector holds nothing.")
  }
}

// ── Panini teams (2026-10-25) ────────────────────────────────────────────────
// get_team_checklist / get_team_intel refused Panini ("RPC has no team data for Panini cards") —
// true until 10-25, when panini_edition_team_keys began placing catalogued cards on franchises
// (the team walk, the team printed on the card, or the same player's other cards in that product).
// This answers from the same reads as the franchise hub's Panini panel. Coverage is PARTIAL by
// construction, so every answer carries it and a team with nothing placed is "not placed yet",
// never "Panini has no cards for that team". No FMV confidence leaves (concierge rule 3).

const PANINI_TEAM_LEAGUES = ["NBA", "WNBA", "NFL", "MLB"] as const

export interface PaniniTeamCandidate {
  league: string
  slug: string
  team_name: string
}

/** Pick a franchise from teams_master rows for a typed name. Exported for the test. */
export function pickPaniniTeam(
  typed: string,
  rows: PaniniTeamCandidate[],
): { status: "one"; team: PaniniTeamCandidate } | { status: "ambiguous"; candidates: PaniniTeamCandidate[] } | { status: "none" } {
  const q = typed.trim().toLowerCase()
  if (!q) return { status: "none" }
  const exact = rows.filter((r) => r.team_name.toLowerCase() === q || r.slug === q.replace(/\s+/g, "-"))
  if (exact.length === 1) return { status: "one", team: exact[0] }
  const hits = exact.length > 1 ? exact : rows.filter((r) => textIncludes(r.team_name, q))
  if (hits.length === 1) return { status: "one", team: hits[0] }
  if (hits.length > 1) return { status: "ambiguous", candidates: hits.slice(0, 8) }
  return { status: "none" }
}

export async function readPaniniTeamForConcierge(db: Db, base: string, typed: string, limit: number): Promise<string> {
  try {
    const q = typed.trim()
    if (!q || q.length > 60) return JSON.stringify({ status: "error", message: "team is required." })
    const { data: tm, error: tmErr } = await db
      .from("teams_master")
      .select("league,slug,team_name")
      .in("league", [...PANINI_TEAM_LEAGUES])
      .eq("active", true)
      .limit(400)
    if (tmErr || !Array.isArray(tm)) {
      return JSON.stringify({ status: "error", message: "The team lookup failed — say the check failed; do NOT say Panini has no cards for that team." })
    }
    const picked = pickPaniniTeam(q, (tm as Record<string, unknown>[]).map((r) => ({ league: String(r.league), slug: String(r.slug), team_name: String(r.team_name) })))
    if (picked.status === "none") {
      return JSON.stringify({ status: "no_results", team: q, message: `No NBA, WNBA, NFL or MLB team matches "${q}". Panini's other sports (soccer, racing) are not on teams — offer a player search instead.` })
    }
    if (picked.status === "ambiguous") {
      return JSON.stringify({ status: "ambiguous", team: q, candidates: picked.candidates.map((c) => ({ league: c.league, team: c.team_name })), message: "More than one franchise matches — ask which, then call again with its full name." })
    }
    const t = picked.team
    const hubUrl = `${base}/teams/${t.league.toLowerCase()}/${encodeURIComponent(t.slug)}`
    const [panel, eds] = await Promise.all([
      db.rpc("get_panini_franchise_panel", { p_league: t.league, p_team_slug: t.slug }),
      db.rpc("get_panini_franchise_editions", { p_league: t.league, p_team_slug: t.slug, p_limit: Math.min(Math.max(limit, 1), 15), p_offset: 0 }),
    ])
    if (panel.error) {
      return JSON.stringify({ status: "error", team: t.team_name, hub_url: hubUrl, message: "The Panini team read failed — say the check failed and link hub_url; do NOT say there are no cards." })
    }
    const p = panel.data as Record<string, unknown> | null
    const cov = (p?.coverage ?? null) as Record<string, unknown> | null
    const coverage = cov && num(cov.catalogued) ? {
      sport: cov.sport ?? null,
      cards_placed_on_a_team: num(cov.mapped),
      cards_tracked: num(cov.catalogued),
    } : null
    const how = "Panini cards carry no team field; RPC places a card on a team from Panini's marketplace team filter, the team printed on the card, or the same player's other cards in that product. A card with none of the three is not counted, so these are floors, not complete checklists."
    if (!p) {
      return JSON.stringify({ status: "none_placed_yet", team: t.team_name, league: t.league, hub_url: hubUrl, how_teams_are_assigned: how,
        message: "RPC has not placed any Panini card on this team yet. Say exactly that — never that Panini has no cards for this team." })
    }
    const rows = eds.error || !Array.isArray(eds.data) ? null : (eds.data as Record<string, unknown>[])
    return JSON.stringify({
      status: "ok",
      team: t.team_name,
      league: t.league,
      hub_url: hubUrl,
      editions_on_team: num(p.edition_count),
      players: num(p.player_count),
      fmv_total_usd: num(p.fmv_total_usd),
      coverage,
      how_teams_are_assigned: how,
      top_editions: rows === null ? null : rows.map((r) => ({
        player: r.player_name ?? null,
        set: r.set_name ?? null,
        fmv_usd: num(r.fmv_usd),
        mint: num(r.circulation_count),
        edition_url: typeof r.route_slug === "string" ? `${base}/panini-blockchain/edition/${encodeURIComponent(r.route_slug)}` : null,
      })),
      top_editions_note: rows === null ? "The edition list failed to load — link hub_url." : "Highest FMV first.",
    })
  } catch {
    return JSON.stringify({ status: "error", message: "The Panini team read failed — say the check failed; do NOT say Panini has no cards for that team." })
  }
}

/**
 * A typed team → the edition keys RPC's Panini team map places on that franchise (2026-10-25), for the
 * deal tool's team filter. ok / ambiguous / none / none_placed_yet / error — never an empty set that
 * would read as "no deals for this team" when the lookup failed.
 */
export async function paniniTeamEditionKeys(
  db: Db,
  typed: string,
): Promise<
  | { status: "ok"; team: string; league: string; slug: string; keys: Set<string> }
  | { status: "ambiguous"; candidates: { league: string; team: string }[] }
  | { status: "none" | "none_placed_yet" | "error"; team?: string }
> {
  try {
    const { data: tm, error } = await db.from("teams_master").select("league,slug,team_name").in("league", [...PANINI_TEAM_LEAGUES]).eq("active", true).limit(400)
    if (error || !Array.isArray(tm)) return { status: "error" }
    const picked = pickPaniniTeam(typed, (tm as Record<string, unknown>[]).map((r) => ({ league: String(r.league), slug: String(r.slug), team_name: String(r.team_name) })))
    if (picked.status === "none") return { status: "none" }
    if (picked.status === "ambiguous") return { status: "ambiguous", candidates: picked.candidates.map((c) => ({ league: c.league, team: c.team_name })) }
    const t = picked.team
    // Paged at PostgREST's 1,000-row cap on a unique key, so a big franchise is never silently truncated
    // (the Lakers held 569 on 2026-10-25). Any failed page fails the whole lookup.
    const keys = new Set<string>()
    for (let from = 0; from < 20_000; from += 1000) {
      const { data, error: kErr } = await db.from("panini_edition_team_keys").select("external_id")
        .contains("franchise_keys", [`${t.league}:${t.slug}`]).order("external_id", { ascending: true }).range(from, from + 999)
      if (kErr || !Array.isArray(data)) return { status: "error", team: t.team_name }
      for (const r of data as Record<string, unknown>[]) keys.add(String(r.external_id))
      if (data.length < 1000) break
    }
    if (keys.size === 0) return { status: "none_placed_yet", team: t.team_name }
    return { status: "ok", team: t.team_name, league: t.league, slug: t.slug, keys }
  } catch {
    return { status: "error" }
  }
}
