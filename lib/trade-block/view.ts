// lib/trade-block/view.ts
//
// What anyone may see of the Trade Block. Shapes stored rows into the public form:
// usernames instead of user ids, each line's collection label, RPC FMV wherever RPC has one
// (`priced`; ask-derived ones flagged `from_asks`), and — the one thing NEVER copied — no wallet address
// (`source` is dropped on every line). Pure and client-safe (type-only store import);
// the routes and pages do the reads.

import { valueSide, type SideValuation } from "@/lib/trade-room/valuation"
import { collectionById, listingState, unsignableCollections, type ListingState } from "@/lib/trade-block/rules"
import type { IndexRead, ItemRow, LoadedListing, LoadedProposal, ProposalItemRow, ProposalStatus } from "@/lib/trade-block/store"

/** Matches lib/trade-room/view.ts ANONYMOUS_USERNAME (not imported: that module is server-side). */
export const ANONYMOUS_USERNAME = "A collector"

export interface LineView {
  collection_id: string
  collection: string
  /** What an asset / person is called in this collection ("pin", "character"). */
  asset_noun: string
  person_noun: string
  kind: "moment" | "edition" | "player"
  moment_id: string | null
  edition_key: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  series_number: number | null
  serial_number: number | null
  image_url: string | null
  fmv_usd: number | null
  priced: boolean
  /** The FMV is ask-derived — rendered "from asks" (lib/fmv-basis.ts), never a confidence tier. */
  from_asks: boolean
  /** Picker only: RPC's last read says it's locked, so it can't be offered. */
  locked: boolean
  /** Picker only (Top Shot): listed for sale on Top Shot — postable, but must be delisted before the trade signs. */
  listed: boolean
  /**
   * Offered moments only: true = still in RPC's index of the account it was posted from;
   * false = it has left that index (it may have moved); null = not re-checked.
   */
  in_index: boolean | null
}

export interface ListingView {
  code: string
  username: string
  is_mine: boolean
  state: ListingState
  note: string | null
  open_to_offers: boolean
  created_at: string
  expires_at: string
  offers: LineView[]
  wants: LineView[]
  /** Collections on the listing (offers and wants), labels, for chips. */
  collections: string[]
  value: SideValuation
}

type AnyLine = Pick<
  ItemRow,
  "collection_id" | "moment_id" | "edition_key" | "player_name" | "set_name" | "tier" | "series_number" | "serial_number" | "image_url" | "fmv_usd"
> & { kind?: ItemRow["kind"]; fmv_from_asks?: ItemRow["fmv_from_asks"]; locked?: boolean; listed?: boolean }

export function lineView(i: AnyLine, inIndex: IndexRead | null | undefined): LineView {
  const c = collectionById(i.collection_id)
  const priced = typeof i.fmv_usd === "number" && Number.isFinite(i.fmv_usd) && i.fmv_usd >= 0
  const kind = i.kind ?? "moment"
  return {
    collection_id: i.collection_id,
    collection: c?.label ?? "Unknown collection",
    asset_noun: c?.asset ?? "asset",
    person_noun: c?.person ?? "player",
    kind,
    moment_id: i.moment_id,
    edition_key: i.edition_key,
    player_name: i.player_name,
    set_name: i.set_name,
    tier: i.tier,
    series_number: i.series_number,
    serial_number: i.serial_number,
    image_url: i.image_url,
    fmv_usd: priced ? (i.fmv_usd as number) : null,
    priced,
    from_asks: priced && i.fmv_from_asks === true,
    // picker rows carry their own lock; a posted offer is locked if RPC's re-read says so now
    locked: i.locked === true || (kind === "moment" && inIndex != null && inIndex.locked.has(`${i.collection_id}:${i.moment_id}`)),
    listed: i.listed === true,
    in_index: kind !== "moment" || inIndex === undefined ? null : inIndex === null ? null : inIndex.held.has(`${i.collection_id}:${i.moment_id}`),
  }
}

export function listingView(
  loaded: LoadedListing,
  names: Map<string, string>,
  viewerId: string | null,
  now: number,
  inIndex?: IndexRead | null,
): ListingView {
  const offers = loaded.items.filter((i) => i.role === "offer").map((i) => lineView(i, inIndex))
  const wants = loaded.items.filter((i) => i.role === "want").map((i) => lineView(i, undefined))
  const collections = [...new Set([...offers, ...wants].map((l) => l.collection))]
  return {
    code: loaded.listing.code,
    username: names.get(loaded.listing.user_id) ?? ANONYMOUS_USERNAME,
    is_mine: viewerId !== null && viewerId === loaded.listing.user_id,
    state: listingState(loaded.listing, now),
    note: loaded.listing.note,
    open_to_offers: loaded.listing.open_to_offers,
    created_at: loaded.listing.created_at,
    expires_at: loaded.listing.expires_at,
    offers,
    wants,
    collections,
    value: valueSide(offers.map((o) => ({ moment_id: o.moment_id ?? "", fmv_usd: o.fmv_usd }))),
  }
}

export interface ProposalView {
  code: string
  listing_code: string | null
  /** The proposer when viewed by the lister; the lister when viewed by the proposer. */
  counterparty: string
  direction: "sent" | "received"
  status: ProposalStatus
  note: string | null
  created_at: string
  decided_at: string | null
  room_code: string | null
  give: LineView[]
  get: LineView[]
  give_value: SideValuation
  get_value: SideValuation
  /** Collections that keep this trade off the signing path; empty = a room can sign it. */
  unsignable: string[]
}

export function proposalView(
  loaded: LoadedProposal,
  opts: { direction: "sent" | "received"; counterparty: string; listingCode: string | null },
): ProposalView {
  const pick = (role: ProposalItemRow["role"]) => loaded.items.filter((i) => i.role === role).map((i) => lineView(i, undefined))
  const give = pick("give")
  const get = pick("get")
  return {
    code: loaded.proposal.code,
    listing_code: opts.listingCode,
    counterparty: opts.counterparty || ANONYMOUS_USERNAME,
    direction: opts.direction,
    status: loaded.proposal.status,
    note: loaded.proposal.note,
    created_at: loaded.proposal.created_at,
    decided_at: loaded.proposal.decided_at,
    room_code: loaded.proposal.room_code,
    give,
    get,
    give_value: valueSide(give.map((g) => ({ moment_id: g.moment_id ?? "", fmv_usd: g.fmv_usd }))),
    get_value: valueSide(get.map((g) => ({ moment_id: g.moment_id ?? "", fmv_usd: g.fmv_usd }))),
    unsignable: unsignableCollections(loaded.items.map((i) => i.collection_id)),
  }
}

/** One line of a priced side for the UI: "$12.40 across 3 · 1 not priced". Never $0 for unknown. */
export function valueLine(v: SideValuation, fmt: (n: number) => string): string {
  if (v.count === 0) return "Nothing"
  if (v.priced === 0) return `${v.count} not priced (not enough sales)`
  const total = `${fmt(v.priced_total_usd ?? 0)} RPC FMV`
  return v.unpriced ? `${total} across ${v.priced} · ${v.unpriced} not priced` : `${total} across ${v.priced}`
}
