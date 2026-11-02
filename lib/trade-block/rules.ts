// lib/trade-block/rules.ts
//
// The Trade Block's pure rules (Trevor, 2026-11-02; docs/strategy/features/trading.md §3):
// which collections can be offered or wanted, the size limits, the listing code, the
// no-cash note filter, and the signing-eligibility rule that decides whether an
// accepted proposal may open a trade room. No I/O and no Node imports here, so client
// pages import it too and every rule is unit-tested without a database.

export const LISTING_TTL_DAYS = 30
export const MAX_LINES_PER_SIDE = 10
export const MAX_OPEN_LISTINGS = 20
export const MAX_PENDING_PROPOSALS = 30
export const NOTE_MAX = 280
export const CODE_RE = /^[a-z0-9]{10}$/
export const FLOW_ADDRESS_RE = /^0x[0-9a-f]{16}$/
export const MOMENT_ID_RE = /^[0-9A-Za-z:_.-]{1,80}$/

export interface BlockCollection {
  id: string
  /** URL segment of the collection's pages (lib/collections.ts COLLECTION_UUID_BY_SLUG key). */
  slug: string
  label: string
  /** What an asset is called. */
  asset: string
  /** What the person on it is called — Pinnacle says "character" (Trevor, 2026-10-31). */
  person: string
  /**
   * Can be OFFERED: a proven Flow/Dapper account can hold it and RPC indexes that
   * account. Panini (Ethereum) and Candy (Solana) have no proof path yet, so they can
   * be wanted but not offered.
   */
  offerable: boolean
  /** A trade room can sign it today (the swap has been proven on this collection only). */
  signable: boolean
}

export const BLOCK_COLLECTIONS: readonly BlockCollection[] = [
  { id: "95f28a17-224a-4025-96ad-adf8a4c63bfd", slug: "nba-top-shot", label: "NBA Top Shot", asset: "Moment", person: "player", offerable: true, signable: true },
  { id: "dee28451-5d62-409e-a1ad-a83f763ac070", slug: "nfl-all-day", label: "NFL All Day", asset: "Moment", person: "player", offerable: true, signable: true },
  { id: "06248cc4-b85f-47cd-af67-1855d14acd75", slug: "laliga-golazos", label: "LaLiga Golazos", asset: "Moment", person: "player", offerable: true, signable: true },
  { id: "7dd9dd11-e8b6-45c4-ac99-71331f959714", slug: "disney-pinnacle", label: "Disney Pinnacle", asset: "pin", person: "character", offerable: true, signable: false },
  { id: "9b4824a8-736d-4a96-b450-8dcc0c46b023", slug: "ufc", label: "UFC Strike", asset: "Moment", person: "fighter", offerable: true, signable: true },
  { id: "209ade70-32c5-4470-bc7c-4793d660f713", slug: "candy-mlb", label: "MLB ICONs", asset: "ICON", person: "player", offerable: false, signable: false },
  { id: "d1a0a7f5-609a-49f4-a1a7-4eaac55b020b", slug: "panini-blockchain", label: "Panini", asset: "card", person: "player", offerable: false, signable: false },
]

const BY_ID = new Map(BLOCK_COLLECTIONS.map((c) => [c.id, c]))
const BY_SLUG = new Map(BLOCK_COLLECTIONS.map((c) => [c.slug, c]))

export function collectionById(id: string | null | undefined): BlockCollection | null {
  return id ? (BY_ID.get(id) ?? null) : null
}

export function collectionBySlug(slug: string | null | undefined): BlockCollection | null {
  return slug ? (BY_SLUG.get(slug) ?? null) : null
}

export const OFFERABLE_COLLECTION_IDS: readonly string[] = BLOCK_COLLECTIONS.filter((c) => c.offerable).map((c) => c.id)

export type NoteCheck = { ok: true; note: string | null } | { ok: false; error: string }

/**
 * NO CASH (Trevor, 2026-11-02) and no off-platform contact: off-platform payment is the
 * trading-scam route. A note that carries one of these is REFUSED with the reason, never
 * silently stripped — a stripped note would publish something the author did not write.
 */
const NOTE_RULES: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|gg|xyz|co|me|ly|app|link)\b/i, why: "links" },
  { re: /[^\s@]+@[^\s@]+\.[a-z]{2,}/i, why: "email addresses" },
  { re: /\b(?:pay\s?pal|venmo|cash\s?app|zelle|apple\s?pay|google\s?pay|western\s?union|crypto|bitcoin|btc|eth(?:ereum)?|usdc|usdt|sol(?:ana)?|flow\s?tokens?|duc|dapper\s?balance)\b/i, why: "payment methods" },
  { re: /[$£€¥]\s?\d|\b\d+(?:[.,]\d+)?\s?(?:usd|dollars?|bucks|k)\b|\b(?:cash|money|paid|payment|plus\s+cash|\+\s*cash)\b/i, why: "cash or prices" },
  { re: /\b(?:discord|telegram|whats\s?app|dm\s+me|text\s+me|hmu|twitter|insta(?:gram)?|snap(?:chat)?)\b|(?:^|\s)@[a-z0-9_]{2,}/i, why: "off-platform contact" },
]

export function checkNote(raw: unknown): NoteCheck {
  if (raw == null) return { ok: true, note: null }
  if (typeof raw !== "string") return { ok: false, error: "The note must be text." }
  const note = raw.replace(/\s+/g, " ").trim()
  if (!note) return { ok: true, note: null }
  if (note.length > NOTE_MAX) return { ok: false, error: `Keep the note under ${NOTE_MAX} characters.` }
  for (const rule of NOTE_RULES) {
    if (rule.re.test(note)) {
      return {
        ok: false,
        error: `Notes can't include ${rule.why}. Trades on RPC are asset for asset with no cash, and they stay on RPC — that's what keeps them safe.`,
      }
    }
  }
  return { ok: true, note }
}

/**
 * Signing eligibility: an accepted proposal may open a trade room only when EVERY
 * moment on both sides is in a collection the room can sign: NBA Top Shot, and since
 * 2026-11-02 NFL All Day, LaLiga Golazos and UFC Strike (lib/trade-room/multi-swap-cadence.ts),
 * in any mix. Disney Pinnacle stays agreement-only: Dapper's filter hides its withdraw
 * capability from a Flow Wallet parent (probed 2026-11-02), and so it does for every pack.
 * Returns the labels of the collections that block it, empty when it can open.
 */
export function unsignableCollections(collectionIds: readonly string[]): string[] {
  const out = new Set<string>()
  for (const id of collectionIds) {
    const c = collectionById(id)
    if (!c?.signable) out.add(c?.label ?? "an unknown collection")
  }
  return [...out]
}

export function isExpired(row: { expires_at: string }, now: number): boolean {
  const t = Date.parse(row.expires_at)
  return !Number.isFinite(t) || t <= now
}

export type ListingState = "open" | "closed" | "expired"

export function listingState(row: { status: string; expires_at: string }, now: number): ListingState {
  if (row.status === "closed") return "closed"
  return isExpired(row, now) ? "expired" : "open"
}
