import { describe, it, expect } from "vitest"
import { askStampKind } from "@/lib/market/ask-freshness"
import { migrationFiles, newestDefinitions } from "./helpers/migration-defs"

// 2026-10-20: askStampKind("nfl_all_day") is "checked", so every All Day ask stamp
// renders as "we last checked this N ago" and goes stale-amber at 12 h. That wording
// is true ONLY while each All Day source of the stamp is the floor listing's on-chain
// VERIFICATION time (`floor_ask_verified_at`). Until that evening the same sources
// carried `floor_ask_listed_at` (when the seller POSTED it) and the kind was "listed";
// flipping the kind without the data — or a later migration quietly restoring
// listed_at under the "checked" kind — publishes a posting date as a check. The kind
// lives in TypeScript and the data in SQL, so no single file shows the pairing: this
// test is where it is held.

const defs = newestDefinitions(migrationFiles())

function body(name: string): string {
  const d = defs.get(name)
  expect(d, `${name} has a migration definition`).toBeDefined()
  expect(d!.dropped, `${name}'s newest definition is not dropped`).toBe(false)
  return d!.body
}

describe("All Day ask stamps are verifications, matching askStampKind", () => {
  it("the kind is checked (the premise of every assertion below)", () => {
    expect(askStampKind("nfl_all_day")).toBe("checked")
    expect(askStampKind("nfl-all-day")).toBe("checked")
  })

  it("allday_edition_floor_ask exposes floor_ask_verified_at from cached_listings_v2.verified_at", () => {
    const b = body("allday_edition_floor_ask")
    expect(b).toMatch(/max\(t\.verified_at\)[\s\S]*AS floor_ask_verified_at/)
  })

  it("the deals MV's All Day arm stamps its ask with floor_ask_verified_at, never floor_ask_listed_at", () => {
    const b = body("mv_cross_collection_deals")
    expect(b).toMatch(/af\.floor_ask_verified_at AS ask_updated_at/)
    expect(b).not.toMatch(/floor_ask_listed_at AS ask_updated_at/)
  })

  it("get_edition_high_offer dates an All Day floor ask by its verification", () => {
    const b = body("get_edition_high_offer")
    expect(b).toMatch(/THEN afa\.floor_ask_verified_at/)
    expect(b).not.toMatch(/floor_ask_listed_at/)
  })

  // Golazos joined the same evening (20261021004010): same kind, same pairing.
  it("Golazos: the kind is checked and its floor view + edition RPC carry the verified stamp", () => {
    expect(askStampKind("laliga_golazos")).toBe("checked")
    expect(body("golazos_edition_floor_ask")).toMatch(/max\(t\.verified_at\)[\s\S]*AS floor_ask_verified_at/)
    const b = body("get_edition_high_offer")
    expect(b).toMatch(/golazos_edition_floor_ask/)
    expect(b).toMatch(/THEN gfa\.floor_ask_verified_at/)
  })

  // 2026-10-20 ~6:20 PM PT: the first two migrations fixed the board MV and the edition RPC but
  // missed edition_current_ask (the price-only alert pool), which kept publishing
  // floor_ask_listed_at as ask_updated_at — a posting date the alert formatter now words as a
  // check. Named objects let a missed reader through; walk them all.
  it("no object anywhere publishes a posting date as ask_updated_at", () => {
    const offenders = [...defs.entries()]
      .filter(([, d]) => !d.dropped && /floor_ask_listed_at\s+AS\s+ask_updated_at/i.test(d.body))
      .map(([name, d]) => `${name} (${d.file})`)
    expect(offenders).toEqual([])
    // not vacuous: the walk sees the object that was missed, and it carries the verified stamp
    expect(body("edition_current_ask")).toMatch(/af\.floor_ask_verified_at AS ask_updated_at/)
    expect(body("edition_current_ask")).toMatch(/gf\.floor_ask_verified_at AS ask_updated_at/)
  })

  it("the autographs board's ask_seen_at is a check on its All Day arm too (public API field)", () => {
    const b = body("v_insights_autographs")
    expect(b).toMatch(/af\.floor_ask_verified_at/)
    expect(b).not.toMatch(/floor_ask_listed_at/)
  })
})
