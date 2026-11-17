import { describe, it, expect } from "vitest"

// Panini in the trophy case (2026-09-28). A Panini owner is a USERNAME linked in
// saved_collector_identities; its cards are pinned by SKU. Pins:
//   · resolvePaniniTrophyCard — ownership against the LINKED usernames only,
//     every display field derived server-side (never the request body), BURNT
//     refused, and a failed read is `ok:false` (503), never "not yours" (403);
//   · trophySlabHref — a Panini slab links to Panini's marketplace, never to a
//     `/moment/<sku>` page RPC does not have;
//   · the art allowlist carries the Panini asset host;
//   · paniniEmptyPoolCopy says WHICH "none" only when it knows.

import { resolvePaniniTrophyCard } from "@/lib/trophy/panini-card"
import { trophySlabHref, PANINI_COLLECTION_ID } from "@/lib/trophy/slab-href"
import { sanitizeTrophyThumbnail } from "@/lib/profile/trophy-thumbnail"
import { paniniEmptyPoolCopy } from "@/lib/trophy-picker-format"

type Result = { data: unknown; error: unknown }

/** A thenable query builder answering per table. */
function fakeDb(tables: Record<string, Result | (() => Result)>) {
  const calls: { table: string; filters: [string, unknown][] }[] = []
  return {
    calls,
    from(table: string) {
      const call = { table, filters: [] as [string, unknown][] }
      calls.push(call)
      const b: any = {
        select: () => b,
        eq: (k: string, v: unknown) => (call.filters.push([k, v]), b),
        in: (k: string, v: unknown) => (call.filters.push([k, v]), b),
        order: () => b,
        limit: () => b,
        then: (res: any, rej: any) => {
          const r = tables[table]
          return Promise.resolve(typeof r === "function" ? r() : r ?? { data: [], error: null }).then(res, rej)
        },
      }
      return b
    },
  }
}

const SKU = "packcard-2063_398995_10651284_4__1_25"
const linked = { data: [{ identity_value: "jdb" }], error: null }
const holding = {
  data: [{
    url_key: SKU, psku: "packcard-2063_398995_10651284_4", serial_number: 1, mint_cap: 25,
    athlete: "Toumani Camara", cardset: "Rookie Roundup", image_url: "pack/942/thumb.png",
  }],
  error: null,
}

describe("resolvePaniniTrophyCard", () => {
  it("derives every display field from the walked card, not the request", async () => {
    const db = fakeDb({ saved_collector_identities: linked, panini_user_holdings: holding, panini_card_serials: { data: [], error: null }, editions: { data: [], error: null } })
    const r = await resolvePaniniTrophyCard(db, "u1", SKU)
    expect(r).toEqual({
      ok: true,
      card: {
        momentId: SKU,
        editionId: "packcard-2063_398995_10651284_4",
        playerName: "Toumani Camara",
        setName: "Rookie Roundup",
        serialNumber: 1,
        circulationCount: 25,
        tier: null,
        thumbnailUrl: "https://assets.paniniamerica.net/catalog/product/pack/942/thumb.png",
      },
    })
    // ownership is checked against THIS user's linked usernames
    const idents = db.calls.find((c) => c.table === "saved_collector_identities")!
    expect(idents.filters).toContainEqual(["user_id", "u1"])
    expect(idents.filters).toContainEqual(["collection_id", PANINI_COLLECTION_ID])
  })

  it("a catalogued card takes the edition's name, set and tier", async () => {
    const db = fakeDb({
      saved_collector_identities: linked, panini_user_holdings: holding,
      panini_card_serials: { data: [], error: null },
      editions: { data: [{ player_name: "Edition Name", set_name: "Edition Set", tier: "LEGENDARY", circulation_count: 25, thumbnail_url: null }], error: null },
    })
    const r = await resolvePaniniTrophyCard(db, "u1", SKU)
    expect(r.ok && r.card && [r.card.playerName, r.card.setName, r.card.tier]).toEqual(["Edition Name", "Edition Set", "LEGENDARY"])
  })

  it("accepts a card the serial index says a linked username owns (not yet walked)", async () => {
    const db = fakeDb({
      saved_collector_identities: linked, panini_user_holdings: { data: [], error: null },
      panini_card_serials: { data: [{ edition_external_id: "packcard-9_9_9_9", serial_number: 7, mint_cap: 50, owner: "JDB", serial_state: "AVAILABLE" }], error: null },
      editions: { data: [], error: null },
    })
    const r = await resolvePaniniTrophyCard(db, "u1", "packcard-9_9_9_9__7_50")
    expect(r.ok && r.card?.serialNumber).toBe(7)
  })

  it("refuses a card owned by someone else", async () => {
    const db = fakeDb({
      saved_collector_identities: linked, panini_user_holdings: { data: [], error: null },
      panini_card_serials: { data: [{ edition_external_id: "packcard-9_9_9_9", serial_number: 7, mint_cap: 50, owner: "someoneelse", serial_state: "AVAILABLE" }], error: null },
    })
    expect(await resolvePaniniTrophyCard(db, "u1", "packcard-9_9_9_9__7_50")).toEqual({ ok: true, card: null })
  })

  it("refuses everything when the user has linked no Panini username", async () => {
    const db = fakeDb({ saved_collector_identities: { data: [], error: null }, panini_user_holdings: holding })
    expect(await resolvePaniniTrophyCard(db, "u1", SKU)).toEqual({ ok: true, card: null })
  })

  it("refuses a BURNT serial even when it is on the walked profile", async () => {
    const db = fakeDb({
      saved_collector_identities: linked, panini_user_holdings: holding,
      panini_card_serials: { data: [{ edition_external_id: null, serial_number: 1, mint_cap: 25, owner: "jdb", serial_state: "BURNT" }], error: null },
    })
    expect(await resolvePaniniTrophyCard(db, "u1", SKU)).toEqual({ ok: true, card: null })
  })

  it("a FAILED read is ok:false — never 'not yours', never 'yours'", async () => {
    for (const broken of ["saved_collector_identities", "panini_user_holdings", "panini_card_serials"]) {
      const tables: Record<string, Result> = {
        saved_collector_identities: linked, panini_user_holdings: holding, panini_card_serials: { data: [], error: null },
      }
      tables[broken] = { data: null, error: { message: "canceling statement due to statement timeout" } }
      const r = await resolvePaniniTrophyCard(fakeDb(tables), "u1", SKU)
      expect(r.ok, broken).toBe(false)
    }
  })
})

describe("trophySlabHref", () => {
  it("a Moment links to its RPC moment page", () => {
    expect(trophySlabHref({ moment_id: "123", collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd" }))
      .toEqual({ kind: "internal", href: "/moment/123" })
  })
  it("a Panini card links to Panini's marketplace, never /moment/<sku>", () => {
    const r = trophySlabHref({ moment_id: SKU, collection_id: PANINI_COLLECTION_ID, edition_id: "packcard-2063_398995_10651284_4" })
    expect(r).toEqual({ kind: "external", href: "https://nft.paniniamerica.net/marketplace-details/packcard-2063_398995_10651284_4.html" })
  })
  it("a Panini card with no valid edition key is unlinked, not a dead link", () => {
    expect(trophySlabHref({ moment_id: SKU, collection_id: PANINI_COLLECTION_ID, edition_id: null })).toEqual({ kind: "none" })
  })
})

describe("Panini trophy art", () => {
  it("the allowlist accepts the Panini asset host", () => {
    const u = "https://assets.paniniamerica.net/catalog/product/pack/942/thumb.png"
    expect(sanitizeTrophyThumbnail(u)).toBe(u)
  })
  it("…and still rejects a look-alike host", () => {
    expect(sanitizeTrophyThumbnail("https://assets.paniniamerica.net.evil.com/x.png")).toBeNull()
  })
})

describe("paniniEmptyPoolCopy", () => {
  it("0 linked → link one", () => expect(paniniEmptyPoolCopy(0)).toMatch(/haven’t linked a Panini username yet/))
  it("linked → not read yet, never 'link one'", () => {
    expect(paniniEmptyPoolCopy(2)).toMatch(/hasn’t read any cards/)
    expect(paniniEmptyPoolCopy(2)).not.toMatch(/haven’t linked/)
  })
  it("unknown → hedged", () => expect(paniniEmptyPoolCopy(null)).toMatch(/^No Panini cards to show yet\. If you haven’t linked/))
})
