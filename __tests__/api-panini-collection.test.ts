import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * GET /api/panini-collection — Panini Collection tab backend (2026-09-27).
 * Stated as the ABSENCE of false claims: a failed read is not an empty
 * collection, a malformed username is not "0 cards", an unpriced card is not $0.
 */

const state: { rpc: { data: unknown; error: unknown }; profile: { data: unknown; error: unknown } } = {
  rpc: { data: null, error: null },
  profile: { data: null, error: null },
}
const calls: unknown[] = []
const profileCalls: unknown[] = []
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: (fn: string, args: unknown) => {
      if (fn === "panini_profile_holdings") {
        profileCalls.push(args)
        return { then: (resolve: any) => resolve(state.profile) }
      }
      calls.push(args)
      return { then: (resolve: any) => resolve(state.rpc) }
    },
  },
}))

import { GET } from "@/app/api/panini-collection/route"
import { parsePaniniOwnerCards, parsePaniniProfileHoldings } from "@/lib/panini/owner-cards"

const req = (qs: string) => ({ nextUrl: new URL("https://t/api/panini-collection" + qs) }) as any
const PAYLOAD = {
  username: "adlcards", cards_seen: 3, listed_now: 2, editions: 3, special_serials: 1, fmv_seen_usd: 700, fmv_priced_cards: 2,
  last_seen_at: "2026-09-27T17:00:00Z",
  cards: [
    { sku: "a", edition_external_id: "packcard-1", serial_number: 1, mint_cap: 10, is_listed: true, ask_usd: 900, fmv_usd: 650, thumbnail_url: "pack/1/x.png", is_number_one: true, player_name: "Lionel Messi", set_name: "Base Prizms Gold" },
    { sku: "b", edition_external_id: "packcard-2", serial_number: 5, mint_cap: 49, is_listed: false, ask_usd: null, fmv_usd: null, thumbnail_url: null },
  ],
}

const NOT_WALKED = { username: "adlcards", walk: null, cards_held: 0, editions: 0, catalogued_cards: 0, listed_now: 0, special_serials: 0, fmv_held_usd: null, fmv_priced_cards: 0, cards: [] }
const WALKED = {
  username: "jamesdillonbond",
  walk: { last_walk_at: "2026-09-27T20:00:00+00:00", last_complete_at: null, profile_state: "public", reported_total: 146, cards_collected: 2, unopened_packs: 12, last_error: "collected 2 of 146 cards" },
  cards_held: 2, editions: 2, catalogued_cards: 1, listed_now: 0, special_serials: 0, fmv_held_usd: 650, fmv_priced_cards: 1,
  cards: [
    { sku: "packcard-1__1_10", edition_external_id: "packcard-1", serial_number: 1, mint_cap: 10, is_listed: false, fmv_usd: 650, catalogued: true, sport: null, thumbnail_url: "https://assets.paniniamerica.net/catalog/product/pack/1/x.png" },
    { sku: "x__4_99", edition_external_id: "x", serial_number: 4, mint_cap: 99, is_listed: false, fmv_usd: null, catalogued: false, sport: "Basketball", thumbnail_url: null },
  ],
}

beforeEach(() => {
  calls.length = 0
  profileCalls.length = 0
  state.rpc = { data: PAYLOAD, error: null }
  state.profile = { data: NOT_WALKED, error: null }
})

describe("GET /api/panini-collection", () => {
  it("folds the username and serves counts + cards with absolute art", async () => {
    const res = await GET(req("?username=@AdlCards"))
    const j = await res.json()
    expect(res.status).toBe(200)
    expect(calls[0]).toEqual({ p_username: "adlcards", p_limit: 200 })
    expect(j).toMatchObject({ username: "adlcards", cardsSeen: 3, listedNow: 2, fmvPricedCards: 2, fmvSeenUsd: 700 })
    expect(j.cards[0].thumbnailUrl).toBe("https://assets.paniniamerica.net/catalog/product/pack/1/x.png")
    expect(j.cards[0].flags).toEqual(["#1"])
    // An unpriced card is null, not 0.
    expect(j.cards[1].fmvUsd).toBeNull()
  })

  it("a missing or malformed username is a 400 — no read, no '0 cards'", async () => {
    for (const qs of ["", "?username=", "?username=0x1234567890abcdef1234"]) {
      const res = await GET(req(qs))
      expect(res.status).toBe(400)
      expect((await res.json()).cardsSeen).toBeUndefined()
    }
    expect(calls).toHaveLength(0)
  })

  it("a failed read is a 503, never an empty collection", async () => {
    state.rpc = { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } }
    const res = await GET(req("?username=adlcards"))
    expect(res.status).toBe(503)
    const j = await res.json()
    expect(j.cardsSeen).toBeUndefined()
    expect(JSON.stringify(j)).not.toContain("canceling statement")
  })

  it("a payload without its counts is 'unavailable', not zeros", async () => {
    state.rpc = { data: { username: "adlcards", cards: [] }, error: null }
    const res = await GET(req("?username=adlcards"))
    expect(res.status).toBeGreaterThanOrEqual(500)
  })

  it("control: a username never seen is a real 0 with no cards", () => {
    const p = parsePaniniOwnerCards({ username: "jamesdillonbond", cards_seen: 0, listed_now: 0, editions: 0, special_serials: 0, fmv_seen_usd: null, fmv_priced_cards: 0, last_seen_at: null, cards: [] })
    expect(p).toMatchObject({ cardsSeen: 0, fmvSeenUsd: null, cards: [] })
  })

  it("carries the profile walk: never-walked is walk:null, not an empty collection", async () => {
    const res = await GET(req("?username=adlcards"))
    const j = await res.json()
    expect(profileCalls[0]).toEqual({ p_username: "adlcards", p_limit: 500 })
    expect(j.profile.walk).toBeNull()
    expect(j.profile.cardsHeld).toBe(0)
  })

  it("a walked username carries the walk's time, completeness and pack count; uncatalogued cards stay unpriced", async () => {
    state.profile = { data: WALKED, error: null }
    const j = await (await GET(req("?username=Jamesdillonbond"))).json()
    expect(j.profile.walk).toMatchObject({ profileState: "public", reportedTotal: 146, cardsCollected: 2, unopenedPacks: 12, lastCompleteAt: null })
    expect(j.profile.cards[1]).toMatchObject({ catalogued: false, sport: "Basketball", fmvUsd: null })
    expect(j.profile.cards[0].catalogued).toBe(true)
  })

  it("a failed PROFILE read is a 503 — half a collection is not the collection", async () => {
    state.profile = { data: null, error: { message: "boom" } }
    const res = await GET(req("?username=adlcards"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).cardsSeen).toBeUndefined()
  })

  it("a profile payload missing its counts, or with a walk lacking its time, is rejected", () => {
    expect(parsePaniniProfileHoldings({ walk: null, cards: [] })).toBeNull()
    expect(parsePaniniProfileHoldings({ ...WALKED, walk: { ...WALKED.walk, last_walk_at: null } })).toBeNull()
    expect(parsePaniniProfileHoldings({ ...WALKED, walk: "yes" })).toBeNull()
    // control
    expect(parsePaniniProfileHoldings(WALKED)?.walk?.unopenedPacks).toBe(12)
  })

  it("an unread pack count stays null, never 0", () => {
    const p = parsePaniniProfileHoldings({ ...WALKED, walk: { ...WALKED.walk, unopened_packs: null } })
    expect(p?.walk?.unopenedPacks).toBeNull()
  })
})
