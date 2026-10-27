// lib/concierge/candy-boards.ts
//
// The concierge's Candy MLB (Solana) reads — Candy ↔ Top Shot parity, 2026-10-26.
//
// Before this file, a Candy question to the concierge fell into one of three holes:
//   · REFUSED — analyze_wallet_holdings / find_quirky_serials answered
//     `unsupported_chain` for every Solana wallet, though wallet_moments_cache holds a full
//     daily census of every Candy card;
//   · SUBSTITUTED — get_special_serial_owners / search_serial_deals / get_hot_floors /
//     get_edition_sweep read TOP SHOT tables unconditionally, so on a Candy page they answered
//     about Top Shot (CLAUDE.md "SUBSTITUTION is the face where nothing fails");
//   · ABSENT FROM THE WRONG TABLE — compare_pack_value read pack_table_rows (0 Candy rows) and
//     said "no buyable packs"; the set tools resolved a base58 wallet as a Top Shot username
//     and asked for "the 0x address".
//
// This module answers from Candy's own planes: /api/candy-set-progress (the Sets tab's backend),
// /api/candy-pack-market (the Packs tab's backend) and candy_special_serials_board.
//
// ── HONESTY ────────────────────────────────────────────────────────────────
//   · A Candy wallet is a base58 Solana key, CASE-SENSITIVE — passed through verbatim, never
//     folded or 0x-prefixed. An SNS name (alice.sol / alice.sns) is resolved; a failed lookup
//     is reported as failed, never as "no such wallet".
//   · A failed read is an ERROR payload, never an empty board (three states).
//   · FMV CONFIDENCE IS INTERNAL (CLAUDE.md concierge rule 3): every confidence field the
//     routes return is dropped here before it reaches the model.
//   · RPC is read-only: links to the tabs and to Magic Eden; never an offer to buy.

import { isSolanaAddress } from "@/lib/address"
import { parseSnsName, resolveSnsName } from "@/lib/chains/solana/sns"
import { resolvePlayerName, singleRetryLabel } from "@/lib/concierge/player-identity"

export const CANDY_COLLECTION_UUID = "209ade70-32c5-4470-bc7c-4793d660f713"
export const CANDY_URL_SLUG = "candy-mlb"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export type CandyWalletResolution =
  | { kind: "wallet"; wallet: string; typed: string; via: "address" | "sns" }
  | { kind: "not_candy" }
  | { kind: "error"; payload: string }

/**
 * A typed Candy collector → a base58 wallet, verbatim. `not_candy` when the input is neither a
 * Solana address nor an SNS name (the caller decides what that means on its page).
 */
export async function resolveCandyWallet(typedRaw: unknown, fetchImpl: typeof fetch = fetch): Promise<CandyWalletResolution> {
  const typed = String(typedRaw ?? "").trim()
  if (!typed) return { kind: "not_candy" }
  if (isSolanaAddress(typed)) return { kind: "wallet", wallet: typed, typed, via: "address" }
  const name = parseSnsName(typed)
  if (!name) return { kind: "not_candy" }
  const r = await resolveSnsName(name, fetchImpl)
  if (r.kind === "resolved") return { kind: "wallet", wallet: r.wallet, typed, via: "sns" }
  if (r.kind === "not_found") {
    return { kind: "error", payload: JSON.stringify({ status: "name_not_found", name, message: `${name} does not point at a Solana wallet. Ask for the Solana wallet address. Do not say the collector owns nothing.` }) }
  }
  return { kind: "error", payload: JSON.stringify({ status: "name_lookup_failed", name, message: "The Solana name lookup failed — say the lookup failed and ask for the wallet address. Never say the name does not exist." }) }
}

/** The message every Candy wallet tool returns when the input is not a Candy collector. */
export const CANDY_NEEDS_SOLANA_WALLET = JSON.stringify({
  status: "need_solana_wallet",
  message: "Candy MLB lives on Solana: a Candy collector is a Solana wallet address (base58, no 0x) or an SNS name like alice.sol. Ask the user for it. A Top Shot username or a 0x Flow wallet holds no Candy cards — never look one up for a Candy question.",
})

// ── Set completion (the Sets tab's backend) ─────────────────────────────────

export async function readCandySetCompletionForConcierge(
  base: string,
  wallet: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const failed = JSON.stringify({ status: "error", message: "The Candy set read failed — say the check failed; never say this wallet has no set progress." })
  try {
    const res = await fetchImpl(`${base}/api/candy-set-progress?wallet=${encodeURIComponent(wallet)}`, { signal: AbortSignal.timeout(12_000) })
    if (!res.ok) return failed
    const body = (await res.json()) as Record<string, unknown>
    const sets = Array.isArray(body.sets) ? (body.sets as Record<string, unknown>[]) : null
    if (!sets) return failed
    const tabUrl = `${base}/${CANDY_URL_SLUG}/sets?wallet=${encodeURIComponent(wallet)}`
    const piece = (p: Record<string, unknown>) => ({
      player: p.playerName ?? null,
      printing: p.tier ?? null,
      ask_usd: num(p.lowestAsk),
      fmv_usd: num(p.fmv),
      serial: num(p.serialNumber),
      edition_url: typeof p.topshotUrl === "string" ? `${base}${p.topshotUrl}` : null,
    })
    return JSON.stringify({
      status: "ok",
      collection: CANDY_URL_SLUG,
      wallet,
      asks_as_of: body.asksAsOf ?? null,
      sets: sets.map((s) => ({
        set: s.setName,
        slots_total: num(s.totalEditions),
        slots_owned: num(s.ownedCount),
        slots_missing: num(s.missingCount),
        completion_pct: num(s.completionPct),
        missing_with_live_ask: num(s.listedCount),
        cost_to_finish_usd: num(s.totalMissingCost),
        every_missing_slot_priced: s.costConfidence === "high",
        cheapest_single_ask_usd: num(s.lowestSingleAsk),
        bottleneck: s.bottleneckPrice != null ? { player: s.bottleneckPlayerName ?? null, ask_usd: num(s.bottleneckPrice) } : null,
        rainbow_printings_owned: num(s.ownedPrintings),
        printings_total: num(s.totalPrintings),
        cheapest_missing: Array.isArray(s.missing) ? (s.missing as Record<string, unknown>[]).slice(0, 8).map(piece) : [],
      })),
      sets_tab_url: tabUrl,
      how_to_read:
        "A Candy set slot is a PLAYER (100 in the 2026 ICONs set); the five-colour Rainbow cards are extra printings of five of those players — depth, not slots. cost_to_finish sums the cheapest live Magic Eden ask per missing slot; when every_missing_slot_priced is false, some missing players have no live ask, so the cost is a lower bound — say so. Quote the numbers; never call a set cheap or a good buy.",
      note: "RPC is read-only — link the Sets tab; never offer to buy.",
    })
  } catch {
    return failed
  }
}

// ── Pack market (the Packs tab's backend) ───────────────────────────────────

export async function readCandyPackMarketForConcierge(base: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const failed = JSON.stringify({ status: "error", message: "The Candy pack read failed — say the check failed; never say there are no Candy packs." })
  try {
    const res = await fetchImpl(`${base}/api/candy-pack-market`, { signal: AbortSignal.timeout(12_000) })
    if (!res.ok) return failed
    const b = (await res.json()) as Record<string, any>
    const m = b.market ?? {}
    const ev = b.ev ?? null
    const cost = num(ev?.packCostUsd) ?? num(b.product?.retailUsd)
    const floor = num(m.confirmedFloorUsd)
    const typical = num(ev?.typicalPullUsd)
    const mean = num(ev?.actualEvUsd)
    // Same verdict ladder as Panini's: a mean edge carried by the Rainbow chase is not a pack
    // that usually pays. Candy publishes no pull odds beyond the model's rainbow chance.
    const basis = floor ?? cost
    let verdict: "no_price" | "no_edge" | "positive_on_mean_only" | "typical_pack_beats_cost" = "no_price"
    if (basis != null && mean != null) {
      if (typical != null && typical >= basis) verdict = "typical_pack_beats_cost"
      else if (mean > basis) verdict = "positive_on_mean_only"
      else verdict = "no_edge"
    }
    return JSON.stringify({
      status: "ok",
      collection: CANDY_URL_SLUG,
      product: b.product?.name ?? "2026 MLB Base Series ICONs",
      retail_usd: num(b.product?.retailUsd),
      declared_supply: num(b.product?.declaredSupply),
      supply: {
        indexed: num(b.supply?.indexed),
        unsold_in_candy_treasury: num(b.supply?.treasuryHeld),
        held_by_collectors: num(b.supply?.collectorHeld),
        collector_wallets: num(b.supply?.collectorWallets),
        opened_burnt: num(b.supply?.burnt),
      },
      market: b.asks_error
        ? { asks_read_failed: true }
        : {
            confirmed_floor_ask_usd: floor,
            confirmed_asks: num(m.confirmedAsks),
            confirmed_within_hours: num(m.confirmedWithinHours),
            sales_7d: num(m.sales7d),
            median_sale_7d_usd: num(m.median7dUsd),
            last_sale_usd: num(m.lastSaleUsd),
            last_sale_at: m.lastSaleAt ?? null,
          },
      ev_model: ev
        ? {
            icon_slots_per_pack: num(ev.iconSlots),
            rainbow_chance_per_pack: num(ev.rainbowChance),
            typical_pull_usd: typical,
            mean_ev_usd: mean,
            note: ev.note ?? null,
          }
        : b.ev_error ? { read_failed: true } : null,
      rip_verdict: verdict,
      how_to_read:
        "rip_verdict compares the pack's value to the cheapest confirmed ask (retail when nothing is listed). Only typical_pack_beats_cost may be described as a pack that usually pays; positive_on_mean_only means the average is carried by rare Rainbow pulls and a typical pack is worth less than it costs. Candy sells ONE pack product; it is NOT in the Flow pack tables.",
      packs_tab_url: `${base}/${CANDY_URL_SLUG}/packs`,
      note: "RPC is read-only — link the Packs tab; never offer to buy.",
    })
  } catch {
    return failed
  }
}

// ── Special serials (candy_special_serials_board) ───────────────────────────

// The board's kinds (measured 2026-10-26: first_mint 125 · jersey_match 107 · last_mint 125 ·
// low_serial 250). The concierge tool's tags are "#1" | "perfect" | "jersey" (Top Shot's words);
// "perfect" is Top Shot's name for the last mint.
const TAG_TO_KIND: Record<string, string> = { "#1": "first_mint", perfect: "last_mint", jersey: "jersey_match" }

export async function readCandySpecialSerialsForConcierge(
  db: Db,
  base: string,
  input: { player?: string | null; holder?: string | null; tag?: string | null; limit?: number | null },
): Promise<string> {
  const failed = JSON.stringify({ status: "error", message: "The Candy special-serial read failed — say the check failed; never say there are none." })
  try {
    const n = Math.min(Math.max(Math.trunc(Number(input.limit ?? 25)) || 25, 1), 100)
    let q = db
      .from("candy_special_serials_board")
      .select("external_id,player_name,edition_name,tier,circulation_count,serial_number,kind,owner,is_treasury,fmv_usd,last_sale_usd,last_sale_at")
    // #207: an ilike is accent-sensitive ("acuna" misses "Acuña") — search the resolver's spelling
    // when the typed name names one Candy player; an ambiguous / unknown name keeps the typed text.
    const typedPlayer = input.player ? String(input.player).trim() : ""
    const player = typedPlayer
      ? (singleRetryLabel(await resolvePlayerName(db, CANDY_COLLECTION_UUID, typedPlayer).catch(() => null), typedPlayer) ?? typedPlayer)
      : ""
    if (player) q = q.ilike("player_name", `%${player.replace(/[%_]/g, (c: string) => "\\" + c)}%`)
    // ⛔ verbatim — a base58 holder is case-sensitive.
    const holder = input.holder ? String(input.holder).trim() : ""
    if (holder) q = q.eq("owner", holder)
    const tag = input.tag ? String(input.tag).trim() : ""
    const { data, error } = await q
      .order("fmv_usd", { ascending: false, nullsFirst: false })
      .order("external_id", { ascending: true })
      .order("serial_number", { ascending: true })
      .range(0, 499)
    if (error || !Array.isArray(data)) return failed
    const wantKind = tag ? (TAG_TO_KIND[tag] ?? null) : null
    const kindMatches = (k: unknown) => !wantKind || String(k ?? "") === wantKind
    const rows = (data as Record<string, unknown>[]).filter((r) => kindMatches(r.kind)).slice(0, n).map((r) => ({
      player: r.player_name,
      printing: r.edition_name,
      serial: num(r.serial_number),
      circulation: num(r.circulation_count),
      kind: r.kind,
      holder: r.is_treasury ? null : (r.owner ?? null),
      still_with_candy_unsold: r.is_treasury === true,
      edition_fmv_usd: num(r.fmv_usd),
      last_sale_usd: num(r.last_sale_usd),
      last_sale_at: r.last_sale_at ?? null,
      edition_url: typeof r.external_id === "string" ? `${base}/${CANDY_URL_SLUG}/edition/${encodeURIComponent(r.external_id)}` : null,
    }))
    if (rows.length === 0) {
      return JSON.stringify({ status: "no_results", collection: CANDY_URL_SLUG, message: "No Candy special serial matches those filters." })
    }
    return JSON.stringify({
      status: "ok",
      collection: CANDY_URL_SLUG,
      total: rows.length,
      rows,
      note: "Candy MLB (Solana). kind: first_mint = serial #1, last_mint = the final serial (Top Shot calls it 'perfect'), jersey_match = serial equals the player's jersey number, low_serial = another low serial. holder is the wallet holding it in RPC's daily on-chain census; still_with_candy_unsold = it sits in Candy's own unsold stock.",
    })
  } catch {
    return failed
  }
}

/** A Top Shot-only tool asked on a Candy page — answered as not applicable, never with Top Shot rows. */
export function candyNotApplicable(tool: string, why: string, instead?: string): string {
  return JSON.stringify({
    status: "not_applicable",
    collection: CANDY_URL_SLUG,
    tool,
    message: `${why}${instead ? ` ${instead}` : ""} Do not answer with Top Shot data on a Candy question.`,
  })
}

// ── Deals (search_live_deals / search_catalog_deals on Candy) ───────────────
// The Flow path called /api/sniper-feed (no Candy source → an empty board) and then
// cached_listings (no Candy rows) and answered "no deals". Candy's deals are its own
// board. Since 2026-09-25 a Candy FMV is capped at the cheapest confirmed ask, so a
// listing BELOW FMV exists only briefly (between a new undercut and the next recalc):
// `candy_deals_board` is usually empty BY CONSTRUCTION. So this answers with the
// below-FMV rows when there are any, and otherwise with the cheapest confirmed asks
// relative to FMV (`closest_to_fmv`) — labelled as such, never as deals.

export const CANDY_ASK_CONFIRMED_HOURS = 12

export async function readCandyDealsForConcierge(
  db: Db,
  base: string,
  input: { player?: string | null; maxPrice?: number | null; tier?: string | null; limit?: number | null },
): Promise<string> {
  const failed = JSON.stringify({ status: "error", message: "The Candy listings read failed — say the check failed; never say there are no Candy deals or listings." })
  try {
    const n = Math.min(Math.max(Math.trunc(Number(input.limit ?? 5)) || 5, 1), 15)
    const typedPlayer = input.player ? String(input.player).trim() : ""
    // #207: the resolver's spelling when it names one Candy player.
    const player = typedPlayer
      ? (singleRetryLabel(await resolvePlayerName(db, CANDY_COLLECTION_UUID, typedPlayer).catch(() => null), typedPlayer) ?? typedPlayer)
      : ""
    const since = new Date(Date.now() - CANDY_ASK_CONFIRMED_HOURS * 3600_000).toISOString()
    let q = db
      .from("candy_market_board")
      .select("external_id,player_name,edition_name,tier,circulation_count,serial_number,ask_usd,fmv_usd,discount_pct,last_seen_at,venue_url")
      .gte("last_seen_at", since)
      .gt("ask_usd", 0)
    if (player) q = q.ilike("player_name", `%${player.replace(/[%_]/g, (c: string) => "\\" + c)}%`)
    const maxPrice = Number(input.maxPrice)
    if (Number.isFinite(maxPrice) && maxPrice > 0) q = q.lte("ask_usd", maxPrice)
    const tier = input.tier ? String(input.tier).trim().toUpperCase() : ""
    if (tier) q = q.eq("tier", tier)
    const { data, error } = await q
      .order("discount_pct", { ascending: false, nullsFirst: false })
      .order("ask_usd", { ascending: true })
      .order("token_mint", { ascending: true })
      .range(0, 199)
    if (error || !Array.isArray(data)) return failed
    const rows = (data as Record<string, unknown>[]).map((r) => {
      const ask = num(r.ask_usd)
      const fmv = num(r.fmv_usd)
      return {
        player: r.player_name,
        printing: r.edition_name,
        serial: num(r.serial_number),
        mint: num(r.circulation_count),
        ask_usd: ask,
        fmv_usd: fmv,
        ask_vs_fmv_pct: ask != null && fmv != null && fmv > 0 ? Math.round(((ask - fmv) / fmv) * 1000) / 10 : null,
        edition_url: typeof r.external_id === "string" ? `${base}/${CANDY_URL_SLUG}/edition/${encodeURIComponent(r.external_id)}` : null,
        listing_url: typeof r.venue_url === "string" ? r.venue_url : null,
      }
    })
    const below = rows.filter((r) => r.ask_vs_fmv_pct != null && r.ask_vs_fmv_pct < 0)
    const scope = player ? ` for ${player}` : ""
    if (below.length > 0) {
      return JSON.stringify({
        status: "ok",
        collection: CANDY_URL_SLUG,
        kind: "below_fmv",
        deals: below.slice(0, n),
        note: `Candy listings confirmed on Magic Eden in the last ${CANDY_ASK_CONFIRMED_HOURS} h asking under FMV${scope}. RPC is read-only — link the listing; never offer to buy.`,
      })
    }
    if (rows.length === 0) {
      return JSON.stringify({
        status: "no_results",
        collection: CANDY_URL_SLUG,
        message: `No Candy listing${scope} confirmed on Magic Eden in the last ${CANDY_ASK_CONFIRMED_HOURS} h matches those filters. Say exactly that — it is about live listings, not about who owns the cards.`,
      })
    }
    const closest = [...rows].sort((a, b) => (a.ask_vs_fmv_pct ?? 1e9) - (b.ask_vs_fmv_pct ?? 1e9)).slice(0, n)
    return JSON.stringify({
      status: "ok",
      collection: CANDY_URL_SLUG,
      kind: "closest_to_fmv",
      deals: [],
      closest_to_fmv: closest,
      note: `No Candy listing${scope} is asking under FMV right now. That is the normal state: a Candy FMV is capped at the cheapest confirmed ask, so an under-FMV listing exists only until the next price update. closest_to_fmv are the confirmed asks nearest their FMV — do NOT call them deals or discounts. RPC is read-only.`,
    })
  } catch {
    return failed
  }
}
