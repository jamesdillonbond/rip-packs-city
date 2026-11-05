import { describe, expect, it } from "vitest"
import { BLOCK_COLLECTIONS, checkNote, collectionBySlug, listingState, unsignableCollections } from "@/lib/trade-block/rules"
import { lineView, listingView, proposalView, valueLine } from "@/lib/trade-block/view"
import { buildBlockNoticeEmail } from "@/lib/trade-block/notify"
import { SWAP_COLLECTIONS } from "@/lib/trade-room/multi-swap-cadence"
import type { ItemRow, LoadedListing, LoadedProposal } from "@/lib/trade-block/store"
import { toHolding } from "@/lib/trade-block/store"

// The Trade Block (Trevor, 2026-11-02; docs/strategy/features/trading.md §3). These pin the
// three decisions he made — public browse that never leaks a wallet, multi-collection
// bundles, NO CASH — and the signing-eligibility seam with the trade room.

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const AD = "dee28451-5d62-409e-a1ad-a83f763ac070"
const PIN = "7dd9dd11-e8b6-45c4-ac99-71331f959714"
const ADDR = "0x3d0b1c2a4e5f6789"

function item(p: Partial<ItemRow>): ItemRow {
  return {
    listing_id: "L",
    role: "offer",
    pos: 0,
    collection_id: TS,
    kind: "moment",
    moment_id: "123",
    source: ADDR,
    edition_key: "73:2619",
    player_name: "Victor Wembanyama",
    set_name: "Base Set",
    tier: "COMMON",
    series_number: 7,
    serial_number: 42,
    image_url: null,
    fmv_usd: 12.5,
    ...p,
  }
}

function listing(items: ItemRow[], over: Partial<LoadedListing["listing"]> = {}): LoadedListing {
  return {
    listing: {
      id: "L",
      code: "abcde12345",
      user_id: "u1",
      note: null,
      open_to_offers: true,
      status: "open",
      closed_reason: null,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      created_at: "2026-11-02T16:00:00Z",
      updated_at: "2026-11-02T16:00:00Z",
      closed_at: null,
      ...over,
    },
    items,
  }
}

describe("no cash, no off-platform contact (checkNote)", () => {
  it.each([
    "+$50 and the Wemby",
    "will add 20 dollars",
    "paypal works",
    "Venmo me",
    "send it on cash app",
    "I take BTC",
    "plus cash if needed",
    "dm me on discord",
    "hit me @collector99",
    "see https://example.com",
    "email me at a@b.co",
    "my site rpc-deals.xyz",
  ])("refuses %j and says why", (note) => {
    const r = checkNote(note)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/can't include/)
  })

  it.each(["Looking for any 2024 rookie of the Spurs", "Series 1 Kobe for my LeBron set", "Will trade 2 for 1 on Legendary", "open to Golazos too"])("keeps %j", (note) => {
    expect(checkNote(note)).toEqual({ ok: true, note })
  })

  it("empty is no note, never an empty string; over-long is refused", () => {
    expect(checkNote("   ")).toEqual({ ok: true, note: null })
    expect(checkNote(null)).toEqual({ ok: true, note: null })
    expect(checkNote("x".repeat(281)).ok).toBe(false)
  })
})

describe("signing eligibility (the seam with the trade room)", () => {
  it("only a trade the room can sign (Top Shot / All Day / Golazos, any mix) may open a room", () => {
    expect(unsignableCollections([TS, TS])).toEqual([])
    expect(unsignableCollections([TS, AD])).toEqual([])
    expect(unsignableCollections([TS, PIN])).toEqual(["Disney Pinnacle"])
    expect(unsignableCollections([PIN])).toEqual(["Disney Pinnacle"])
  })

  it("the signable set is exactly the collections the swap Cadence moves", () => {
    expect(BLOCK_COLLECTIONS.filter((c) => c.signable).map((c) => c.slug)).toEqual(SWAP_COLLECTIONS.map((c) => c.slug))
    expect(BLOCK_COLLECTIONS.filter((c) => c.signable).map((c) => c.id)).toEqual(SWAP_COLLECTIONS.map((c) => c.collectionId))
  })

  it("chains without a proof path can be wanted but not offered", () => {
    expect(collectionBySlug("panini-blockchain")?.offerable).toBe(false)
    expect(collectionBySlug("candy-mlb")?.offerable).toBe(false)
    expect(collectionBySlug("nfl-all-day")?.offerable).toBe(true)
  })

  it("Pinnacle names a character, never a player (Trevor, 2026-10-31)", () => {
    expect(collectionBySlug("disney-pinnacle")?.person).toBe("character")
  })
})

describe("listing state", () => {
  it("expired is derived, closed wins", () => {
    const now = Date.parse("2026-11-02T16:00:00Z")
    expect(listingState({ status: "open", expires_at: "2026-11-03T00:00:00Z" }, now)).toBe("open")
    expect(listingState({ status: "open", expires_at: "2026-11-01T00:00:00Z" }, now)).toBe("expired")
    expect(listingState({ status: "closed", expires_at: "2026-12-01T00:00:00Z" }, now)).toBe("closed")
    expect(listingState({ status: "open", expires_at: "garbage" }, now)).toBe("expired")
  })
})

describe("the public view never carries a wallet address", () => {
  it("drops `source` from every line and no 0x address survives anywhere", () => {
    const loaded = listing([item({}), item({ role: "want", kind: "player", moment_id: null, source: null, pos: 0, collection_id: PIN, player_name: "Stitch", fmv_usd: null })])
    const v = listingView(loaded, new Map([["u1", "webz_80"]]), null, Date.now(), new Set([`${TS}:123`]))
    const json = JSON.stringify(v)
    expect(json).not.toMatch(/0x[0-9a-f]{16}/i)
    expect(json).not.toMatch(/"source"/)
    expect(json).not.toMatch(/"user_id"/)
    expect(v.username).toBe("webz_80")
  })

  it("the proposal view drops it too", () => {
    const p: LoadedProposal = {
      proposal: { id: "P", code: "zzzzz00000", listing_id: "L", user_id: "u2", status: "pending", note: null, room_code: null, created_at: "", updated_at: "", decided_at: null },
      items: [{ proposal_id: "P", role: "give", pos: 0, collection_id: PIN, moment_id: "9", source: ADDR, edition_key: "4790", player_name: "A", set_name: null, tier: null, series_number: null, serial_number: null, image_url: null, fmv_usd: null }],
    }
    const v = proposalView(p, { direction: "received", counterparty: "ThunderHour", listingCode: "abcde12345" })
    expect(JSON.stringify(v)).not.toMatch(/0x[0-9a-f]{16}|"source"/i)
    expect(v.unsignable).toEqual(["Disney Pinnacle"])
  })
})

describe("prices: confident FMV only, never $0 for unknown", () => {
  it("an ask-derived FMV still shows, flagged from_asks; a stored line carries no marker", () => {
    expect(lineView({ ...item({ fmv_usd: 40 }), fmv_from_asks: true }, undefined)).toMatchObject({ priced: true, fmv_usd: 40, from_asks: true })
    expect(lineView(item({ fmv_usd: 40 }), undefined).from_asks).toBe(false)
  })

  it("a null FMV is `not priced`, not zero", () => {
    const l = lineView(item({ fmv_usd: null }), undefined)
    expect(l.priced).toBe(false)
    expect(l.fmv_usd).toBeNull()
  })

  it("the value line names unpriced lines instead of summing them as zero", () => {
    const v = listingView(listing([item({ pos: 0 }), item({ pos: 1, moment_id: "124", fmv_usd: null })]), new Map(), null, Date.now())
    const line = valueLine(v.value, (n) => `$${n.toFixed(2)}`)
    expect(line).toBe("$12.50 RPC FMV across 1 · 1 not priced")
    const none = listingView(listing([item({ fmv_usd: null })]), new Map(), null, Date.now())
    expect(valueLine(none.value, (n) => `$${n}`)).toBe("1 not priced (not enough sales)")
  })
})

describe("re-check of offered lines: three states", () => {
  it("in index · left the index · not re-checked", () => {
    const row = item({})
    expect(lineView(row, new Set([`${TS}:123`])).in_index).toBe(true)
    expect(lineView(row, new Set()).in_index).toBe(false)
    expect(lineView(row, null).in_index).toBeNull()
    expect(lineView(item({ kind: "player", role: "want", moment_id: null, source: null }), new Set()).in_index).toBeNull()
  })
})

describe("notices carry no asset, price or wallet", () => {
  it.each(["proposal", "accepted", "declined"] as const)("%s", (n) => {
    const m = buildBlockNoticeEmail(n, { other: "sdb", roomCode: n === "accepted" ? "abcde12345" : null })
    const all = `${m.subject}\n${m.html}\n${m.text}`
    expect(all).toMatch(/sdb/)
    expect(all).not.toMatch(/0x[0-9a-f]{16}|\$\d|FMV|confidence/i)
  })

  it("an accepted all-Top-Shot proposal links the room; otherwise it says nothing moves", () => {
    expect(buildBlockNoticeEmail("accepted", { other: "x", roomCode: "abcde12345" }).text).toMatch(/\/trades\/abcde12345/)
    expect(buildBlockNoticeEmail("accepted", { other: "x", roomCode: null }).text).toMatch(/nothing moves/)
  })
})

describe("toHolding (the picker row)", () => {
  const w = {
    wallet_address: ADDR,
    collection_id: TS,
    moment_id: "1",
    edition_key: "1:2",
    player_name: "LeBron James",
    character_name: null,
    set_name: "The Anthology",
    tier: "LEGENDARY",
    series_number: 7,
    serial_number: 56,
    image_url: null,
    fmv_usd: "2880",
    fmv_confidence: "ASK_ONLY",
    is_locked: true,
  }
  it("shows RPC's FMV at any confidence — LOW / STALE / ASK_ONLY are not 'not priced'", () => {
    for (const c of ["HIGH", "MEDIUM", "LOW", "STALE", "ASK_ONLY", null]) {
      expect(toHolding({ ...w, fmv_confidence: c }).fmv_usd).toBe(2880)
    }
    expect(toHolding({ ...w, fmv_usd: null }).fmv_usd).toBeNull()
  })
  it("flags only ask-derived FMV, and never carries the tier", () => {
    expect(toHolding(w).fmv_from_asks).toBe(true)
    expect(toHolding({ ...w, fmv_confidence: "LOW" }).fmv_from_asks).toBe(false)
    expect(JSON.stringify(toHolding(w))).not.toMatch(/ASK_ONLY|HIGH|MEDIUM|LOW|STALE/)
  })
  it("carries the lock, and a locked line renders unselectable", () => {
    expect(toHolding(w).locked).toBe(true)
    expect(toHolding({ ...w, is_locked: null }).locked).toBe(false)
    expect(lineView({ ...toHolding(w), kind: "moment" }, undefined).locked).toBe(true)
  })
})
