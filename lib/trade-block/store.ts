// lib/trade-block/store.ts
//
// The Trade Block's data half (migration 20261102162558; docs/strategy/features/trading.md
// §3). Server-only, service role. Every mutation is scoped to the caller: a user edits
// only their own listings, decides only proposals on their own listings, and withdraws
// only their own proposals.
//
// Ownership: an OFFERED or GIVEN moment must sit in an account the user PROVED
// (trade_block_wallets, plus any account they proved in a trade room) and in RPC's
// index of that account (wallet_moments_cache, scoped by collection_id — a moment_id is
// unique only within a collection). That index is a cache, so the public view re-checks
// it and labels a line that left it "may have moved"; the trade room re-reads the chain
// before anything signs.
//
// Honesty: every read throws on failure (the routes answer 503 + retryable copy); no
// failed read is ever published as "holds nothing" or "no listings".

import type { SupabaseClient } from "@supabase/supabase-js"
import { createRoom, loadRoom, newRoomCode } from "@/lib/trade-room/store"
import {
  CODE_RE,
  checkNote,
  collectionById,
  FLOW_ADDRESS_RE,
  isExpired,
  LISTING_TTL_DAYS,
  MAX_LINES_PER_SIDE,
  MAX_OPEN_LISTINGS,
  MAX_PENDING_PROPOSALS,
  MOMENT_ID_RE,
  OFFERABLE_COLLECTION_IDS,
  unsignableCollections,
} from "@/lib/trade-block/rules"
import { swapCollectionById } from "@/lib/trade-room/multi-swap-cadence"
import { isAskDerivedFmv } from "@/lib/fmv-basis"

/** A refusal with copy written for the user (routes publish `.copy`, never a driver message). */
export class TradeBlockError extends Error {
  readonly copy: string
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = "TradeBlockError"
    this.copy = message
  }
}

function fail(error: { message: string } | null, what: string): never {
  throw new Error(`${what}: ${error?.message ?? "no rows returned"}`)
}

export const HOLDINGS_LIMIT = 500

// ── proven accounts ──────────────────────────────────────────────────────────

export interface ProvenAccount {
  source: string
  signer: string
  proven_at: string | null
}

/** Accounts the user proved on the block, plus every account they proved in a trade room. */
export async function provenAccounts(db: SupabaseClient, userId: string): Promise<ProvenAccount[]> {
  const [block, rooms] = await Promise.all([
    db.from("trade_block_wallets").select("source, signer, proven_at").eq("user_id", userId),
    db.from("trade_room_sides").select("source, signer, proven_at").eq("user_id", userId).not("source", "is", null),
  ])
  if (block.error) fail(block.error, "trade_block_wallets read")
  if (rooms.error) fail(rooms.error, "trade_room_sides read")
  const out = new Map<string, ProvenAccount>()
  for (const r of [...(block.data ?? []), ...(rooms.data ?? [])] as Array<{ source: string | null; signer: string | null; proven_at: string | null }>) {
    if (!r.source || !r.signer || !FLOW_ADDRESS_RE.test(r.source)) continue
    const prev = out.get(r.source)
    if (!prev || (r.proven_at ?? "") > (prev.proven_at ?? "")) out.set(r.source, { source: r.source, signer: r.signer, proven_at: r.proven_at })
  }
  return [...out.values()].sort((a, b) => (b.proven_at ?? "").localeCompare(a.proven_at ?? ""))
}

export async function saveProvenAccount(db: SupabaseClient, userId: string, signer: string, source: string): Promise<void> {
  if (!FLOW_ADDRESS_RE.test(signer) || !FLOW_ADDRESS_RE.test(source)) throw new TradeBlockError("Not a Flow address.", 400, "bad_address")
  const { error } = await db
    .from("trade_block_wallets")
    .upsert({ user_id: userId, signer, source, proven_at: new Date().toISOString() }, { onConflict: "user_id,source" })
  if (error) fail(error, "trade_block_wallets upsert")
}

// ── holdings (the picker) ────────────────────────────────────────────────────

export interface Holding {
  collection_id: string
  moment_id: string
  source: string
  edition_key: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  series_number: number | null
  serial_number: number | null
  image_url: string | null
  /** RPC FMV whenever RPC has one (as on the collection pages), else null (not priced). The tier never leaves the server. */
  fmv_usd: number | null
  /** The FMV is ask-derived (no corroborating sales) — shown as "from asks" (lib/fmv-basis.ts). Stored on the line. */
  fmv_from_asks: boolean
  /** RPC's last read says the asset is locked, so it can't be traded. Picker-only; never stored on a line. */
  locked: boolean
  /** Top Shot only, picker-only: listed for sale on Top Shot right now (read from the chain). Postable —
   *  it is discovery — but the trade room refuses it until the listing is cancelled. Absent = not read. */
  listed?: boolean
}

type WmcRow = {
  wallet_address: string
  collection_id: string
  moment_id: string
  edition_key: string | null
  player_name: string | null
  character_name: string | null
  set_name: string | null
  tier: string | null
  series_number: number | null
  serial_number: number | null
  image_url: string | null
  fmv_usd: number | string | null
  fmv_confidence: string | null
  is_locked: boolean | null
}

const WMC_COLS =
  "wallet_address, collection_id, moment_id, edition_key, player_name, character_name, set_name, tier, series_number, serial_number, image_url, fmv_usd, fmv_confidence, is_locked"

export function toHolding(w: WmcRow): Holding {
  // 2026-11-04 (Trevor): the picker showed "not priced" on 344 of his top 500 — every LOW / STALE /
  // ASK_ONLY row — while the collection page shows those same FMVs. A line shows RPC's FMV whenever it
  // has one; an ask-derived one says so ("from asks"), per the platform basis rule. The tier stays here.
  const fmv = w.fmv_usd == null ? null : Number(w.fmv_usd)
  const priced = fmv != null && Number.isFinite(fmv) && fmv >= 0
  const pinnacle = collectionById(w.collection_id)?.person === "character"
  return {
    collection_id: w.collection_id,
    moment_id: String(w.moment_id),
    source: w.wallet_address,
    edition_key: w.edition_key ?? null,
    // Pinnacle: the CHARACTER, never the pin's own name (CLAUDE.md, Pinnacle grain)
    player_name: (pinnacle ? (w.character_name ?? w.player_name) : (w.player_name ?? w.character_name)) ?? null,
    set_name: w.set_name ?? null,
    tier: w.tier ?? null,
    series_number: w.series_number ?? null,
    serial_number: w.serial_number ?? null,
    image_url: w.image_url ?? null,
    fmv_usd: priced ? fmv : null,
    fmv_from_asks: priced && isAskDerivedFmv(w.fmv_confidence),
    locked: w.is_locked === true,
  }
}

/** A Holding as stored on a listing / proposal line: `locked` is a picker hint, not a column. */
function storedLine(h: Holding): Omit<Holding, "locked" | "listed"> {
  const { locked: _locked, listed: _listed, ...line } = h
  return line
}

const TOP_SHOT_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

/**
 * Tag the Top Shot rows that are listed for sale on Top Shot (2026-11-04). One chain read per
 * account that has Top Shot rows, bounded; best-effort — a failed or slow read leaves rows untagged
 * (the trade room re-reads it and refuses a listed Moment before anything signs).
 */
export async function markListed(
  rows: Holding[],
  read: (address: string) => Promise<Set<string>>,
  budgetMs = 4_000,
): Promise<Holding[]> {
  const accounts = [...new Set(rows.filter((r) => r.collection_id === TOP_SHOT_ID).map((r) => r.source))]
  if (accounts.length === 0) return rows
  let timer: ReturnType<typeof setTimeout> | undefined
  const bySource = new Map<string, Set<string>>()
  try {
    const reads = await Promise.race([
      Promise.all(accounts.map(async (a) => [a, await read(a).catch(() => null)] as const)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("listed read budget")), budgetMs) }),
    ])
    for (const [a, set] of reads) if (set) bySource.set(a, set)
  } catch {
    return rows
  } finally {
    if (timer) clearTimeout(timer)
  }
  return rows.map((r) => {
    if (r.collection_id !== TOP_SHOT_ID) return r
    const set = bySource.get(r.source)
    return set ? { ...r, listed: set.has(r.moment_id) } : r
  })
}

export interface HoldingsResult {
  /** False when RPC has indexed nothing at all in these accounts (never "holds nothing"). */
  indexed: boolean
  rows: Holding[]
  truncated: boolean
}

/** Indexed assets across the user's proven accounts, offerable collections only. */
export async function readHoldings(
  db: SupabaseClient,
  sources: readonly string[],
  opts: { collectionId?: string | null; q?: string | null } = {},
): Promise<HoldingsResult> {
  if (sources.length === 0) return { indexed: false, rows: [], truncated: false }
  const collections = opts.collectionId ? OFFERABLE_COLLECTION_IDS.filter((c) => c === opts.collectionId) : OFFERABLE_COLLECTION_IDS
  if (collections.length === 0) throw new TradeBlockError("That collection can't be offered on the Trade Block yet.", 400, "not_offerable")
  const needle = (opts.q ?? "").replace(/[%_\\,()]/g, "").trim()
  let query = db
    .from("wallet_moments_cache")
    .select(WMC_COLS, { count: "exact" })
    .in("wallet_address", [...sources])
    .in("collection_id", collections)
  if (needle) query = query.or(`player_name.ilike.%${needle}%,character_name.ilike.%${needle}%,set_name.ilike.%${needle}%`)
  // unlocked first — a wallet can be mostly locked (Trevor's top 500 was 478 locked), and locked
  // assets can't be offered, so they must not crowd the tradeable ones out of the 500
  const { data, error, count } = await query
    .order("is_locked", { ascending: true, nullsFirst: true })
    .order("fmv_usd", { ascending: false, nullsFirst: false })
    .order("moment_id")
    .limit(HOLDINGS_LIMIT)
  if (error) fail(error, "wallet_moments_cache read")
  const rows = ((data ?? []) as WmcRow[]).map(toHolding)
  let indexed = rows.length > 0
  if (!indexed && (needle || opts.collectionId)) {
    const { count: any, error: anyError } = await db
      .from("wallet_moments_cache")
      .select("moment_id", { count: "exact", head: true })
      .in("wallet_address", [...sources])
      .in("collection_id", OFFERABLE_COLLECTION_IDS as string[])
    if (anyError) fail(anyError, "wallet_moments_cache count")
    indexed = (any ?? 0) > 0
  }
  return { indexed, rows, truncated: typeof count === "number" && count > rows.length }
}

export interface AssetRef {
  collection_id: string
  moment_id: string
}

function parseRefs(raw: unknown, what: string): AssetRef[] {
  if (!Array.isArray(raw)) return []
  const out: AssetRef[] = []
  const seen = new Set<string>()
  for (const r of raw) {
    const collection_id = String((r as AssetRef)?.collection_id ?? "")
    const moment_id = String((r as AssetRef)?.moment_id ?? "").trim()
    if (!collectionById(collection_id) || !MOMENT_ID_RE.test(moment_id)) throw new TradeBlockError(`A ${what} line is not a valid asset.`, 400, "bad_ref")
    const k = `${collection_id}:${moment_id}`
    if (seen.has(k)) throw new TradeBlockError(`The same asset is listed twice in ${what}.`, 400, "duplicate")
    seen.add(k)
    out.push({ collection_id, moment_id })
  }
  return out
}

/**
 * The held rows for `refs` in the user's proven accounts. Throws a user-facing refusal
 * naming the first ref that is not in any proven account.
 */
export async function requireHeld(db: SupabaseClient, userId: string, refs: readonly AssetRef[]): Promise<Holding[]> {
  if (refs.length === 0) return []
  for (const r of refs) {
    if (!collectionById(r.collection_id)?.offerable) {
      throw new TradeBlockError(`${collectionById(r.collection_id)?.label ?? "That collection"} can't be offered yet — there's no way to prove you hold it.`, 400, "not_offerable")
    }
  }
  const accounts = await provenAccounts(db, userId)
  if (accounts.length === 0) throw new TradeBlockError("Prove a Flow Wallet first, so the Trade Block knows these are yours.", 409, "no_wallet")
  const { data, error } = await db
    .from("wallet_moments_cache")
    .select(WMC_COLS)
    .in("wallet_address", accounts.map((a) => a.source))
    .in("collection_id", [...new Set(refs.map((r) => r.collection_id))])
    .in("moment_id", [...new Set(refs.map((r) => r.moment_id))])
  if (error) fail(error, "wallet_moments_cache held read")
  const byKey = new Map<string, Holding>()
  for (const w of (data ?? []) as WmcRow[]) byKey.set(`${w.collection_id}:${w.moment_id}`, toHolding(w))
  return refs.map((r) => {
    const h = byKey.get(`${r.collection_id}:${r.moment_id}`)
    if (!h) {
      throw new TradeBlockError(
        `${collectionById(r.collection_id)?.label ?? ""} #${r.moment_id} isn't in an account you've proved (as of RPC's last read of it).`.trim(),
        409,
        "not_held",
      )
    }
    if (h.locked) {
      throw new TradeBlockError(
        `${h.player_name ?? `#${r.moment_id}`}${h.serial_number != null ? ` #${h.serial_number}` : ""} is locked, so it can't be traded. Unlock it first (as of RPC's last read).`,
        409,
        "locked",
      )
    }
    return h
  })
}

// ── listings ─────────────────────────────────────────────────────────────────

export interface ListingRow {
  id: string
  code: string
  user_id: string
  note: string | null
  open_to_offers: boolean
  status: "open" | "closed"
  closed_reason: string | null
  expires_at: string
  created_at: string
  updated_at: string
  closed_at: string | null
}

export interface ItemRow {
  listing_id: string
  role: "offer" | "want"
  pos: number
  collection_id: string
  kind: "moment" | "edition" | "player"
  moment_id: string | null
  source: string | null
  edition_key: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  series_number: number | null
  serial_number: number | null
  image_url: string | null
  fmv_usd: number | null
  /** null on lines stored before 2026-11-04 (basis unknown → no marker). */
  fmv_from_asks: boolean | null
}

export interface LoadedListing {
  listing: ListingRow
  items: ItemRow[]
}

const LISTING_COLS = "id, code, user_id, note, open_to_offers, status, closed_reason, expires_at, created_at, updated_at, closed_at"
const ITEM_COLS =
  "listing_id, role, pos, collection_id, kind, moment_id, source, edition_key, player_name, set_name, tier, series_number, serial_number, image_url, fmv_usd, fmv_from_asks"

function numify<T extends { fmv_usd: number | string | null }>(r: T): T {
  return { ...r, fmv_usd: r.fmv_usd == null ? null : Number(r.fmv_usd) }
}

export interface WantInput {
  collection_id: string
  kind: "edition" | "player"
  edition_key?: string
  player_name?: string
}

interface ResolvedWant {
  collection_id: string
  kind: "edition" | "player"
  edition_key: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
}

/** Wants: an edition (checked against the catalog, which supplies its labels) or a player/character name. */
async function resolveWants(db: SupabaseClient, raw: unknown): Promise<ResolvedWant[]> {
  if (!Array.isArray(raw)) return []
  const out: ResolvedWant[] = []
  const seen = new Set<string>()
  for (const w of raw as WantInput[]) {
    const c = collectionById(String(w?.collection_id ?? ""))
    if (!c) throw new TradeBlockError("A want names an unknown collection.", 400, "bad_want")
    if (w.kind === "edition") {
      const key = String(w.edition_key ?? "").trim()
      if (!key || key.length > 120) throw new TradeBlockError("A want names no edition.", 400, "bad_want")
      const { data, error } = await db
        .from("editions")
        .select("external_id, id, player_name, set_name, tier")
        .eq("collection_id", c.id)
        .or(`external_id.eq.${key.replace(/[,()]/g, "")},id.eq.${/^[0-9a-f-]{36}$/i.test(key) ? key : "00000000-0000-0000-0000-000000000000"}`)
        .limit(1)
      if (error) fail(error, "editions want read")
      const e = (data ?? [])[0] as { external_id: string | null; id: string; player_name: string | null; set_name: string | null; tier: string | null } | undefined
      if (!e) throw new TradeBlockError(`That ${c.label} edition isn't in RPC's catalog.`, 400, "unknown_edition")
      const ek = e.external_id ?? e.id
      if (seen.has(`${c.id}:e:${ek}`)) continue
      seen.add(`${c.id}:e:${ek}`)
      out.push({ collection_id: c.id, kind: "edition", edition_key: ek, player_name: e.player_name, set_name: e.set_name, tier: e.tier })
    } else if (w.kind === "player") {
      const name = String(w.player_name ?? "").replace(/\s+/g, " ").trim()
      if (name.length < 2 || name.length > 80) throw new TradeBlockError(`Name the ${c.person} you want (2–80 characters).`, 400, "bad_want")
      const nc = checkNote(name)
      if (!nc.ok) throw new TradeBlockError(nc.error, 400, "bad_want")
      const k = `${c.id}:p:${name.toLowerCase()}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push({ collection_id: c.id, kind: "player", edition_key: null, player_name: name, set_name: null, tier: null })
    } else {
      throw new TradeBlockError("A want must be an edition or a player.", 400, "bad_want")
    }
  }
  return out
}

export interface CreateListingInput {
  offers?: unknown
  wants?: unknown
  note?: unknown
  open_to_offers?: unknown
}

export async function createListing(db: SupabaseClient, userId: string, input: CreateListingInput, now: number = Date.now()): Promise<LoadedListing> {
  const offers = parseRefs(input.offers, "your offer")
  if (offers.length === 0) throw new TradeBlockError("Pick at least one asset to put on the block.", 400, "empty")
  if (offers.length > MAX_LINES_PER_SIDE) throw new TradeBlockError(`At most ${MAX_LINES_PER_SIDE} assets per listing.`, 400, "too_many")
  const wants = await resolveWants(db, input.wants)
  if (wants.length > MAX_LINES_PER_SIDE) throw new TradeBlockError(`At most ${MAX_LINES_PER_SIDE} wants per listing.`, 400, "too_many")
  const note = checkNote(input.note)
  if (!note.ok) throw new TradeBlockError(note.error, 400, "bad_note")
  const openToOffers = input.open_to_offers !== false
  if (wants.length === 0 && !openToOffers) throw new TradeBlockError("Say what you want back, or leave the listing open to offers.", 400, "no_wants")

  const { count, error: countError } = await db
    .from("trade_block_listings")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "open")
    .gt("expires_at", new Date(now).toISOString())
  if (countError) fail(countError, "trade_block_listings count")
  if ((count ?? 0) >= MAX_OPEN_LISTINGS) throw new TradeBlockError(`You have ${count} open listings. Close one first.`, 429, "too_many_listings")

  const held = await requireHeld(db, userId, offers)
  // an asset already on another of the user's OPEN listings is not listed twice
  const { data: mine, error: mineError } = await db
    .from("trade_block_listings")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "open")
    .gt("expires_at", new Date(now).toISOString())
  if (mineError) fail(mineError, "trade_block_listings open read")
  const openIds = ((mine ?? []) as Array<{ id: string }>).map((r) => r.id)
  if (openIds.length) {
    const { data: dup, error: dupError } = await db
      .from("trade_block_items")
      .select("moment_id, collection_id")
      .in("listing_id", openIds)
      .eq("role", "offer")
      .in("moment_id", offers.map((o) => o.moment_id))
    if (dupError) fail(dupError, "trade_block_items duplicate read")
    for (const d of (dup ?? []) as Array<{ moment_id: string; collection_id: string }>) {
      if (offers.some((o) => o.moment_id === d.moment_id && o.collection_id === d.collection_id)) {
        throw new TradeBlockError(`#${d.moment_id} is already on one of your open listings.`, 409, "already_listed")
      }
    }
  }

  const { data: listing, error } = await db
    .from("trade_block_listings")
    .insert({
      code: newRoomCode(),
      user_id: userId,
      note: note.note,
      open_to_offers: openToOffers,
      expires_at: new Date(now + LISTING_TTL_DAYS * 24 * 3600 * 1000).toISOString(),
    })
    .select(LISTING_COLS)
    .single()
  if (error || !listing) fail(error, "trade_block_listings insert")
  const l = listing as ListingRow
  const rows = [
    ...held.map((h, pos) => ({ listing_id: l.id, role: "offer", pos, kind: "moment", ...storedLine(h) })),
    ...wants.map((w, pos) => ({
      listing_id: l.id,
      role: "want",
      pos,
      kind: w.kind,
      collection_id: w.collection_id,
      edition_key: w.edition_key,
      player_name: w.player_name,
      set_name: w.set_name,
      tier: w.tier,
    })),
  ]
  const { error: itemError } = await db.from("trade_block_items").insert(rows)
  if (itemError) {
    // all-or-nothing: a listing without its lines must not stay published
    const { error: undoError } = await db.from("trade_block_listings").delete().eq("id", l.id)
    fail(itemError, `trade_block_items insert${undoError ? ` (and the empty listing could not be removed: ${undoError.message})` : ""}`)
  }
  return loadListing(db, l.code)
}

export async function loadListing(db: SupabaseClient, code: string): Promise<LoadedListing> {
  if (!CODE_RE.test(code)) throw new TradeBlockError("No such listing.", 404, "not_found")
  const { data, error } = await db.from("trade_block_listings").select(LISTING_COLS).eq("code", code).maybeSingle()
  if (error) fail(error, "trade_block_listings read")
  if (!data) throw new TradeBlockError("No such listing.", 404, "not_found")
  const listing = data as ListingRow
  const { data: items, error: itemError } = await db.from("trade_block_items").select(ITEM_COLS).eq("listing_id", listing.id).order("role").order("pos")
  if (itemError) fail(itemError, "trade_block_items read")
  return { listing, items: ((items ?? []) as ItemRow[]).map(numify) }
}

export async function closeListing(db: SupabaseClient, userId: string, code: string, now: number = Date.now()): Promise<LoadedListing> {
  const loaded = await loadListing(db, code)
  if (loaded.listing.user_id !== userId) throw new TradeBlockError("Only the collector who posted it can close this listing.", 403, "not_yours")
  if (loaded.listing.status === "closed") return loaded
  const stamp = new Date(now).toISOString()
  const { error } = await db
    .from("trade_block_listings")
    .update({ status: "closed", closed_reason: "owner", closed_at: stamp, updated_at: stamp })
    .eq("id", loaded.listing.id)
    .eq("status", "open")
  if (error) fail(error, "trade_block_listings close")
  // pending proposals on a closed listing are declined, so nobody waits on a dead post
  const { error: propError } = await db
    .from("trade_block_proposals")
    .update({ status: "declined", decided_at: stamp, updated_at: stamp })
    .eq("listing_id", loaded.listing.id)
    .eq("status", "pending")
  if (propError) fail(propError, "trade_block_proposals decline on close")
  return loadListing(db, code)
}

export interface ListFilter {
  collectionId?: string | null
  q?: string | null
  /** One edition (its catalog key): listings offering a copy of it or wanting it. */
  editionKey?: string | null
  limit?: number
  /** created_at cursor: listings older than this. */
  before?: string | null
}

/** Pages of 1,000 the filter's candidate read may take before it refuses (never a partial set). */
export const FILTER_MAX_PAGES = 10

/** Open, unexpired listings, newest first, with their lines. */
export async function listOpenListings(db: SupabaseClient, f: ListFilter = {}, now: number = Date.now()): Promise<{ listings: LoadedListing[]; next_before: string | null }> {
  const limit = Math.min(Math.max(f.limit ?? 24, 1), 48)
  const needle = (f.q ?? "").replace(/[%_\\,()]/g, "").trim()
  const edition = (f.editionKey ?? "").trim()
  let ids: string[] | null = null
  if (f.collectionId || needle || edition) {
    // The candidate listings come from their LINES. PostgREST clamps a read at 1,000 rows, so
    // the read is PAGED on the lines' primary key; a filter that would need more than
    // FILTER_MAX_PAGES pages throws (503) rather than answer from a partial set.
    const found = new Set<string>()
    for (let page = 0; ; page++) {
      if (page >= FILTER_MAX_PAGES) throw new Error("trade_block_items filter: candidate set exceeds the paging bound")
      let iq = db.from("trade_block_items").select("listing_id, role, pos")
      if (f.collectionId) iq = iq.eq("collection_id", f.collectionId)
      if (edition) iq = iq.eq("edition_key", edition)
      if (needle) iq = iq.or(`player_name.ilike.%${needle}%,set_name.ilike.%${needle}%`)
      const { data, error } = await iq.order("listing_id").order("role").order("pos").range(page * 1000, page * 1000 + 999)
      if (error) fail(error, "trade_block_items filter")
      const rows = (data ?? []) as Array<{ listing_id: string }>
      for (const r of rows) found.add(r.listing_id)
      if (rows.length < 1000) break
    }
    ids = [...found]
    if (ids.length === 0) return { listings: [], next_before: null }
  }
  // a large candidate set is read in id chunks (a URL carries only so many ids), each the
  // newest `limit + 1`, then merged — the newest overall are among the newest of each chunk
  const chunks: Array<string[] | null> = ids ? [] : [null]
  if (ids) for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200))
  const reads = await Promise.all(
    chunks.map((chunk) => {
      let lq = db
        .from("trade_block_listings")
        .select(LISTING_COLS)
        .eq("status", "open")
        .gt("expires_at", new Date(now).toISOString())
      if (chunk) lq = lq.in("id", chunk)
      if (f.before) lq = lq.lt("created_at", f.before)
      return lq.order("created_at", { ascending: false }).order("id").limit(limit + 1)
    }),
  )
  const merged: ListingRow[] = []
  for (const { data, error } of reads) {
    if (error) fail(error, "trade_block_listings list")
    merged.push(...((data ?? []) as ListingRow[]))
  }
  const rows = merged.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id)).slice(0, limit + 1)
  const page = rows.slice(0, limit)
  const items = await itemsFor(db, page.map((l) => l.id))
  return {
    listings: page.map((listing) => ({ listing, items: items.get(listing.id) ?? [] })),
    next_before: rows.length > limit ? page[page.length - 1].created_at : null,
  }
}

export async function itemsFor(db: SupabaseClient, listingIds: string[]): Promise<Map<string, ItemRow[]>> {
  const out = new Map<string, ItemRow[]>()
  if (listingIds.length === 0) return out
  // PostgREST clamps a read at 1,000 rows. A listing has at most 2 × MAX_LINES_PER_SIDE
  // lines, so a chunk of 40 listings (≤ 800 lines) can never be clamped — a silently
  // truncated read here would drop a listing's lines, not fail.
  const CHUNK = Math.floor(1000 / (2 * MAX_LINES_PER_SIDE)) - 10
  const chunks: string[][] = []
  for (let i = 0; i < listingIds.length; i += CHUNK) chunks.push(listingIds.slice(i, i + CHUNK))
  const reads = await Promise.all(chunks.map((ids) => db.from("trade_block_items").select(ITEM_COLS).in("listing_id", ids).order("listing_id").order("role").order("pos")))
  for (const { data, error } of reads) {
    if (error) fail(error, "trade_block_items list")
    for (const r of (data ?? []) as ItemRow[]) {
      const list = out.get(r.listing_id) ?? []
      list.push(numify(r))
      out.set(r.listing_id, list)
    }
  }
  return out
}

/** Every open, unexpired listing (newest first, bounded) with its lines — the matcher's population. */
export const MATCH_POPULATION_LIMIT = 300
export async function allOpenListings(db: SupabaseClient, now: number = Date.now()): Promise<{ listings: LoadedListing[]; complete: boolean }> {
  const { data, error } = await db
    .from("trade_block_listings")
    .select(LISTING_COLS)
    .eq("status", "open")
    .gt("expires_at", new Date(now).toISOString())
    .order("created_at", { ascending: false })
    .order("id")
    .limit(MATCH_POPULATION_LIMIT + 1)
  if (error) fail(error, "trade_block_listings open (match)")
  const rows = (data ?? []) as ListingRow[]
  const page = rows.slice(0, MATCH_POPULATION_LIMIT)
  const items = await itemsFor(db, page.map((l) => l.id))
  return { listings: page.map((listing) => ({ listing, items: items.get(listing.id) ?? [] })), complete: rows.length <= MATCH_POPULATION_LIMIT }
}

export async function listingsOf(db: SupabaseClient, userId: string): Promise<LoadedListing[]> {
  const { data, error } = await db.from("trade_block_listings").select(LISTING_COLS).eq("user_id", userId).order("created_at", { ascending: false }).limit(50)
  if (error) fail(error, "trade_block_listings mine")
  const rows = (data ?? []) as ListingRow[]
  const items = await itemsFor(db, rows.map((l) => l.id))
  return rows.map((listing) => ({ listing, items: items.get(listing.id) ?? [] }))
}

/**
 * Which offered lines are still in RPC's index of the account they were posted from.
 * Keyed `${collection_id}:${moment_id}`. Returns null when the check itself failed, so
 * the caller shows "not re-checked" — never "gone".
 */
/** What RPC's index says NOW about a set of offered lines (keys `collection_id:moment_id`). */
export interface IndexRead {
  /** Still in RPC's index of the account each was posted from. */
  held: Set<string>
  /** Held, but RPC's last read says locked — can't be traded until unlocked (2026-11-04). */
  locked: Set<string>
}

export async function stillIndexed(db: SupabaseClient, lines: ReadonlyArray<{ collection_id: string; moment_id: string | null; source: string | null }>): Promise<IndexRead | null> {
  const real = lines.filter((l) => l.moment_id && l.source)
  if (real.length === 0) return { held: new Set(), locked: new Set() }
  const { data, error } = await db
    .from("wallet_moments_cache")
    .select("wallet_address, collection_id, moment_id, is_locked")
    .in("wallet_address", [...new Set(real.map((l) => l.source as string))])
    .in("collection_id", [...new Set(real.map((l) => l.collection_id))])
    .in("moment_id", [...new Set(real.map((l) => l.moment_id as string))])
  if (error) return null
  const rows = (data ?? []) as Array<{ wallet_address: string; collection_id: string; moment_id: string; is_locked: boolean | null }>
  const have = new Map(rows.map((r) => [`${r.wallet_address}|${r.collection_id}:${r.moment_id}`, r.is_locked === true]))
  const out: IndexRead = { held: new Set(), locked: new Set() }
  for (const l of real) {
    const k = `${l.source}|${l.collection_id}:${l.moment_id}`
    if (!have.has(k)) continue
    out.held.add(`${l.collection_id}:${l.moment_id}`)
    if (have.get(k)) out.locked.add(`${l.collection_id}:${l.moment_id}`)
  }
  return out
}

// ── proposals ────────────────────────────────────────────────────────────────

export type ProposalStatus = "pending" | "accepted" | "declined" | "withdrawn"

export interface ProposalRow {
  id: string
  code: string
  listing_id: string
  user_id: string
  status: ProposalStatus
  note: string | null
  room_code: string | null
  created_at: string
  updated_at: string
  decided_at: string | null
}

export interface ProposalItemRow {
  proposal_id: string
  role: "give" | "get"
  pos: number
  collection_id: string
  moment_id: string
  source: string | null
  edition_key: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  series_number: number | null
  serial_number: number | null
  image_url: string | null
  fmv_usd: number | null
  /** null on lines stored before 2026-11-04 (basis unknown → no marker). */
  fmv_from_asks: boolean | null
}

export interface LoadedProposal {
  proposal: ProposalRow
  items: ProposalItemRow[]
}

const PROPOSAL_COLS = "id, code, listing_id, user_id, status, note, room_code, created_at, updated_at, decided_at"
const PITEM_COLS =
  "proposal_id, role, pos, collection_id, moment_id, source, edition_key, player_name, set_name, tier, series_number, serial_number, image_url, fmv_usd, fmv_from_asks"

export interface ProposeInput {
  give?: unknown
  get?: unknown
  note?: unknown
}

export async function propose(db: SupabaseClient, userId: string, listingCode: string, input: ProposeInput, now: number = Date.now()): Promise<LoadedProposal> {
  const loaded = await loadListing(db, listingCode)
  const { listing } = loaded
  if (listing.user_id === userId) throw new TradeBlockError("That's your own listing.", 409, "own_listing")
  if (listing.status !== "open") throw new TradeBlockError("This listing is closed.", 409, "closed")
  if (isExpired(listing, now)) throw new TradeBlockError("This listing expired.", 409, "expired")
  const give = parseRefs(input.give, "what you give")
  const get = parseRefs(input.get, "what you get")
  if (give.length === 0) throw new TradeBlockError("Pick at least one asset you'd give.", 400, "empty_give")
  if (get.length === 0) throw new TradeBlockError("Pick at least one of the listed assets you want.", 400, "empty_get")
  if (give.length > MAX_LINES_PER_SIDE || get.length > MAX_LINES_PER_SIDE) throw new TradeBlockError(`At most ${MAX_LINES_PER_SIDE} assets per side.`, 400, "too_many")
  const note = checkNote(input.note)
  if (!note.ok) throw new TradeBlockError(note.error, 400, "bad_note")

  const offered = new Map(loaded.items.filter((i) => i.role === "offer" && i.moment_id).map((i) => [`${i.collection_id}:${i.moment_id}`, i]))
  const getLines = get.map((g) => {
    const line = offered.get(`${g.collection_id}:${g.moment_id}`)
    if (!line) throw new TradeBlockError("You can only ask for assets this listing offers.", 400, "not_offered")
    return line
  })

  const { count, error: countError } = await db
    .from("trade_block_proposals")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "pending")
  if (countError) fail(countError, "trade_block_proposals count")
  if ((count ?? 0) >= MAX_PENDING_PROPOSALS) throw new TradeBlockError(`You have ${count} pending proposals. Withdraw one first.`, 429, "too_many_proposals")

  // an offered asset locked since it was posted can't be traded — refuse it by name (2026-11-04).
  // A failed read does not block: the room re-reads the chain before anything signs.
  const now_ = await stillIndexed(db, getLines)
  const lockedGet = now_ ? getLines.find((i) => now_.locked.has(`${i.collection_id}:${i.moment_id}`)) : undefined
  if (lockedGet) {
    throw new TradeBlockError(
      `${lockedGet.player_name ?? `#${lockedGet.moment_id}`}${lockedGet.serial_number != null ? ` #${lockedGet.serial_number}` : ""} is locked now, so it can't be traded until it's unlocked.`,
      409,
      "locked",
    )
  }

  const held = await requireHeld(db, userId, give)
  const { data: p, error } = await db
    .from("trade_block_proposals")
    .insert({ code: newRoomCode(), listing_id: listing.id, user_id: userId, note: note.note })
    .select(PROPOSAL_COLS)
    .single()
  if (error) {
    if (error.code === "23505") throw new TradeBlockError("You already have a pending proposal on this listing. Withdraw it to send a new one.", 409, "already_pending")
    fail(error, "trade_block_proposals insert")
  }
  const prop = p as ProposalRow
  const strip = (i: ItemRow) => ({
    collection_id: i.collection_id,
    moment_id: i.moment_id as string,
    source: null,
    edition_key: i.edition_key,
    player_name: i.player_name,
    set_name: i.set_name,
    tier: i.tier,
    series_number: i.series_number,
    serial_number: i.serial_number,
    image_url: i.image_url,
    fmv_usd: i.fmv_usd,
    fmv_from_asks: i.fmv_from_asks,
  })
  const rows = [
    ...held.map((h, pos) => ({ proposal_id: prop.id, role: "give", pos, ...storedLine(h) })),
    ...getLines.map((i, pos) => ({ proposal_id: prop.id, role: "get", pos, ...strip(i) })),
  ]
  const { error: itemError } = await db.from("trade_block_proposal_items").insert(rows)
  if (itemError) {
    // all-or-nothing: a proposal without its lines must not reach the lister
    const { error: undoError } = await db.from("trade_block_proposals").delete().eq("id", prop.id)
    fail(itemError, `trade_block_proposal_items insert${undoError ? ` (and the empty proposal could not be removed: ${undoError.message})` : ""}`)
  }
  return loadProposal(db, prop.code)
}

export async function loadProposal(db: SupabaseClient, code: string): Promise<LoadedProposal> {
  if (!CODE_RE.test(code)) throw new TradeBlockError("No such proposal.", 404, "not_found")
  const { data, error } = await db.from("trade_block_proposals").select(PROPOSAL_COLS).eq("code", code).maybeSingle()
  if (error) fail(error, "trade_block_proposals read")
  if (!data) throw new TradeBlockError("No such proposal.", 404, "not_found")
  const proposal = data as ProposalRow
  const { data: items, error: itemError } = await db.from("trade_block_proposal_items").select(PITEM_COLS).eq("proposal_id", proposal.id).order("role").order("pos")
  if (itemError) fail(itemError, "trade_block_proposal_items read")
  return { proposal, items: ((items ?? []) as ProposalItemRow[]).map(numify) }
}

/** Proposals the user SENT, and proposals on listings the user POSTED. */
export async function proposalsFor(db: SupabaseClient, userId: string, myListingIds: readonly string[]): Promise<{ sent: LoadedProposal[]; received: LoadedProposal[] }> {
  const [sent, received] = await Promise.all([
    db.from("trade_block_proposals").select(PROPOSAL_COLS).eq("user_id", userId).order("created_at", { ascending: false }).limit(50),
    myListingIds.length
      ? db.from("trade_block_proposals").select(PROPOSAL_COLS).in("listing_id", [...myListingIds]).order("created_at", { ascending: false }).limit(100)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (sent.error) fail(sent.error, "trade_block_proposals sent")
  if (received.error) fail(received.error as { message: string }, "trade_block_proposals received")
  const all = [...((sent.data ?? []) as ProposalRow[]), ...((received.data ?? []) as ProposalRow[])]
  const items = new Map<string, ProposalItemRow[]>()
  if (all.length) {
    // Chunked like itemsFor (2026-11-07 review): up to 150 proposals × 20 lines is
    // 3,000 rows, and PostgREST clamps one read at 1,000 — silently, so proposals
    // rendered with missing lines and give/get values summed from a partial list.
    const ids = [...new Set(all.map((p) => p.id))]
    const CHUNK = Math.floor(1000 / (2 * MAX_LINES_PER_SIDE)) - 10
    const chunks: string[][] = []
    for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK))
    const reads = await Promise.all(
      chunks.map((c) => db.from("trade_block_proposal_items").select(PITEM_COLS).in("proposal_id", c).order("proposal_id").order("role").order("pos")),
    )
    for (const { data, error } of reads) {
      if (error) fail(error, "trade_block_proposal_items list")
      for (const r of (data ?? []) as ProposalItemRow[]) {
        const list = items.get(r.proposal_id) ?? []
        list.push(numify(r))
        items.set(r.proposal_id, list)
      }
    }
  }
  const wrap = (p: ProposalRow): LoadedProposal => ({ proposal: p, items: items.get(p.id) ?? [] })
  return { sent: ((sent.data ?? []) as ProposalRow[]).map(wrap), received: ((received.data ?? []) as ProposalRow[]).map(wrap) }
}

export interface DecideOutcome {
  proposal: LoadedProposal
  /** The trade room opened for a proposal the room can sign (Top Shot / All Day / Golazos); null otherwise. */
  room_code: string | null
  /** Collections that keep this trade off the signing path (empty when a room opened). */
  unsignable: string[]
}

/** The lister accepts or declines a pending proposal on their listing. */
export async function decide(db: SupabaseClient, userId: string, proposalCode: string, accept: boolean, now: number = Date.now()): Promise<DecideOutcome> {
  const loaded = await loadProposal(db, proposalCode)
  const { proposal } = loaded
  const { data: l, error: lError } = await db.from("trade_block_listings").select(LISTING_COLS).eq("id", proposal.listing_id).maybeSingle()
  if (lError) fail(lError, "trade_block_listings for proposal")
  const listing = l as ListingRow | null
  if (!listing || listing.user_id !== userId) throw new TradeBlockError("Only the collector who posted the listing can answer this proposal.", 403, "not_yours")
  if (proposal.status !== "pending") throw new TradeBlockError(`This proposal was already ${proposal.status}.`, 409, proposal.status)
  const stamp = new Date(now).toISOString()
  const unsignable = accept ? unsignableCollections(loaded.items.map((i) => i.collection_id)) : []
  // ⛔ CLAIM THE PROPOSAL FIRST (2026-11-07 review). The room used to be created
  // BEFORE this conditional update, so a double-click (or two tabs) made two
  // live rooms with both users seated — the loser threw "stale" and left an
  // orphan room in both /trades lists, counting toward MAX_LIVE_ROOMS.
  const { data, error } = await db
    .from("trade_block_proposals")
    .update({ status: accept ? "accepted" : "declined", decided_at: stamp, updated_at: stamp })
    .eq("id", proposal.id)
    .eq("status", "pending")
    .select("id")
  if (error) fail(error, "trade_block_proposals decide")
  if (!Array.isArray(data) || data.length !== 1) throw new TradeBlockError("This proposal changed while you were answering it. Reload.", 409, "stale")
  let roomCode: string | null = null
  if (accept && unsignable.length === 0) {
    // the lister becomes side A, the proposer side B; both still prove wallets and pick
    // in the room, whose chain checks gate everything that signs
    let roomId: string | null = null
    try {
      const room = await createRoom(db, userId, now)
      roomId = room.room.id
      const { error: sideError } = await db.from("trade_room_sides").insert({ room_id: room.room.id, side: "b", user_id: proposal.user_id })
      if (sideError) fail(sideError, "trade_room_sides insert (from block)")
      const { error: statusError } = await db.from("trade_rooms").update({ status: "building", updated_at: stamp }).eq("id", room.room.id).eq("status", "open")
      if (statusError) fail(statusError, "trade_rooms building (from block)")
      roomCode = (await loadRoom(db, room.room.code)).room.code
      const { error: linkError } = await db.from("trade_block_proposals").update({ room_code: roomCode, updated_at: stamp }).eq("id", proposal.id)
      if (linkError) fail(linkError, "trade_block_proposals room link")
    } catch (e) {
      // No room for an accepted proposal is a dead end for both collectors: hand the
      // proposal back (pending, no room) and cancel any half-made room, then report.
      // Both rollback writes are BOUND: a rollback that silently failed would leave an
      // accepted proposal with no room (or a live orphan room) and say nothing.
      const { error: undoError } = await db.from("trade_block_proposals").update({ status: "pending", decided_at: null, updated_at: stamp }).eq("id", proposal.id).is("room_code", null)
      if (undoError) console.error(`[trade-block/decide] rollback to pending failed for proposal ${proposal.id}: ${undoError.message}`)
      if (roomId) {
        const { error: roomUndoError } = await db.from("trade_rooms").update({ status: "cancelled", cancelled_by: userId, cancel_reason: "room setup failed", updated_at: stamp }).eq("id", roomId)
        if (roomUndoError) console.error(`[trade-block/decide] cancelling half-made room ${roomId} failed: ${roomUndoError.message}`)
      }
      throw e
    }
  }
  return { proposal: await loadProposal(db, proposalCode), room_code: roomCode, unsignable }
}

export async function withdraw(db: SupabaseClient, userId: string, proposalCode: string, now: number = Date.now()): Promise<LoadedProposal> {
  const loaded = await loadProposal(db, proposalCode)
  if (loaded.proposal.user_id !== userId) throw new TradeBlockError("Only the collector who sent it can withdraw this proposal.", 403, "not_yours")
  if (loaded.proposal.status !== "pending") return loaded
  const stamp = new Date(now).toISOString()
  const { error } = await db
    .from("trade_block_proposals")
    .update({ status: "withdrawn", decided_at: stamp, updated_at: stamp })
    .eq("id", loaded.proposal.id)
    .eq("status", "pending")
  if (error) fail(error, "trade_block_proposals withdraw")
  return loadProposal(db, proposalCode)
}

/** The listing a proposal is on (for notices and views). */
export async function listingById(db: SupabaseClient, id: string): Promise<ListingRow | null> {
  const { data, error } = await db.from("trade_block_listings").select(LISTING_COLS).eq("id", id).maybeSingle()
  if (error) fail(error, "trade_block_listings by id")
  return (data as ListingRow | null) ?? null
}

export async function listingsByIds(db: SupabaseClient, ids: readonly string[]): Promise<Map<string, ListingRow>> {
  const out = new Map<string, ListingRow>()
  if (ids.length === 0) return out
  const { data, error } = await db.from("trade_block_listings").select(LISTING_COLS).in("id", [...new Set(ids)])
  if (error) fail(error, "trade_block_listings by ids")
  for (const r of (data ?? []) as ListingRow[]) out.set(r.id, r)
  return out
}

/**
 * The accepted proposal a trade room was opened from, shaped for the room: the LISTER is
 * side A (they accepted, which created the room) and gives the proposal's "get" lines; the
 * PROPOSER is side B and gives its "give" lines. Null when the room did not come from the
 * block. Throws on a failed read.
 */
export async function proposalForRoom(
  db: SupabaseClient,
  roomCode: string,
): Promise<{ listing_code: string | null; a_gives: AgreedLine[]; b_gives: AgreedLine[] } | null> {
  if (!CODE_RE.test(roomCode)) return null
  const { data, error } = await db.from("trade_block_proposals").select(PROPOSAL_COLS).eq("room_code", roomCode).limit(1)
  if (error) fail(error, "trade_block_proposals by room")
  const p = ((data ?? []) as ProposalRow[])[0]
  if (!p) return null
  const loaded = await loadProposal(db, p.code)
  const listing = await listingById(db, p.listing_id)
  const line = (i: ProposalItemRow): AgreedLine => ({
    collection: swapCollectionById(i.collection_id)?.short ?? collectionById(i.collection_id)?.label ?? null,
    moment_id: i.moment_id,
    player_name: i.player_name,
    set_name: i.set_name,
    serial_number: i.serial_number,
  })
  return {
    listing_code: listing?.code ?? null,
    a_gives: loaded.items.filter((i) => i.role === "get").map(line),
    b_gives: loaded.items.filter((i) => i.role === "give").map(line),
  }
}

export interface AgreedLine {
  /** The collection's short name ("All Day") — moment ids collide across collections, so the
   *  guide must say which. Null for a collection the block does not know. */
  collection: string | null
  moment_id: string
  player_name: string | null
  set_name: string | null
  serial_number: number | null
}
