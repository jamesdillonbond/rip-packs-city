import { describe, it, expect } from "vitest"
import {
  checkChallengePin,
  parseChallengeRules,
  playerLabelMatches,
} from "@/lib/trophy/challenge-rules"
import { PANINI_COLLECTION_ID } from "@/lib/trophy/slab-href"

// Pins the server-side Dame Time rule check (2026-11-06). The player is the
// EDITION's, resolved through the collector's own wallets — never the request
// body's `playerName`.

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const DAME = parseChallengeRules({
  player_names: ["Damian Lillard"],
  collection_slugs: ["nba_top_shot", "panini_blockchain"],
  require_owned: true,
})

type Tables = Record<string, { data: any; error: any }>

/** A table-keyed fake supabase client: every chain on table T resolves to tables[T]. */
function fakeDb(tables: Tables, calls: { table: string; filters: any[] }[] = []) {
  return {
    from(table: string) {
      const rec = { table, filters: [] as any[] }
      calls.push(rec)
      const b: any = {}
      for (const m of ["select", "eq", "in", "not", "limit", "is", "order"]) {
        b[m] = (...args: any[]) => {
          rec.filters.push([m, ...args])
          return b
        }
      }
      b.then = (resolve: any) => resolve(tables[table] ?? { data: [], error: null })
      return b
    },
  }
}

const happy: Tables = {
  collections: { data: [{ slug: "nba_top_shot" }], error: null },
  saved_wallets: { data: [{ wallet_addr: "0xabc" }], error: null },
  wallet_moments_cache: { data: [{ edition_key: "1:2" }], error: null },
  editions: { data: [{ player_name: "Damian Lillard" }], error: null },
}

const input = { userId: "u1", momentId: "m1", collectionId: TS, paniniPlayerName: null }

describe("playerLabelMatches — a name is not a substring", () => {
  it("matches the exact player, case/whitespace-insensitively", () => {
    expect(playerLabelMatches("Damian Lillard", ["Damian Lillard"])).toBe(true)
    expect(playerLabelMatches("  damian   LILLARD ", ["Damian Lillard"])).toBe(true)
  })
  it("matches a multi-player Panini card that features him", () => {
    expect(playerLabelMatches("Damian Lillard | Donovan Mitchell", ["Damian Lillard"])).toBe(true)
  })
  it("does NOT match a different player who shares a word", () => {
    expect(playerLabelMatches("Damian Jones", ["Damian Lillard"])).toBe(false)
    expect(playerLabelMatches("Damian Lillard Jr.", ["Damian Lillard"])).toBe(false)
  })
  it("an absent label is not a match", () => {
    expect(playerLabelMatches(null, ["Damian Lillard"])).toBe(false)
  })
})

describe("checkChallengePin — Dame Time", () => {
  it("a held Dame Top Shot Moment is eligible", async () => {
    expect((await checkChallengePin(fakeDb(happy), DAME, "Dame Time", input)).kind).toBe("eligible")
  })

  it("resolves ownership through the collector's OWN saved wallets", async () => {
    const calls: { table: string; filters: any[] }[] = []
    await checkChallengePin(fakeDb(happy, calls), DAME, "Dame Time", input)
    const wmc = calls.find((c) => c.table === "wallet_moments_cache")!
    expect(wmc.filters).toContainEqual(["in", "wallet_address", ["0xabc"]])
    // collection-scoped: a moment_id is unique only within a collection
    expect(wmc.filters).toContainEqual(["eq", "collection_id", TS])
  })

  it("another player's Moment is ineligible and says whose it is", async () => {
    const r = await checkChallengePin(
      fakeDb({ ...happy, editions: { data: [{ player_name: "Anfernee Simons" }], error: null } }),
      DAME,
      "Dame Time",
      input
    )
    expect(r.kind).toBe("ineligible")
    if (r.kind === "ineligible") {
      expect(r.status).toBe(422)
      expect(r.error).toContain("Anfernee Simons")
    }
  })

  it("a Moment not in the collector's wallets is ineligible (403)", async () => {
    const r = await checkChallengePin(
      fakeDb({ ...happy, wallet_moments_cache: { data: [], error: null } }),
      DAME,
      "Dame Time",
      input
    )
    expect(r).toMatchObject({ kind: "ineligible", status: 403 })
  })

  it("a collection outside the challenge is ineligible", async () => {
    const r = await checkChallengePin(
      fakeDb({ ...happy, collections: { data: [{ slug: "nfl_all_day" }], error: null } }),
      DAME,
      "Dame Time",
      input
    )
    expect(r.kind).toBe("ineligible")
  })

  it("⚠ a FAILED read is 'unchecked', never 'that isn't a Dame Moment'", async () => {
    for (const t of ["collections", "saved_wallets", "wallet_moments_cache", "editions"]) {
      const r = await checkChallengePin(
        fakeDb({ ...happy, [t]: { data: null, error: { message: "boom" } } }),
        DAME,
        "Dame Time",
        input
      )
      expect(r.kind, t).toBe("unchecked")
    }
  })

  it("a missing edition row says we can't identify it, not that it isn't Dame", async () => {
    const r = await checkChallengePin(
      fakeDb({ ...happy, editions: { data: [], error: null } }),
      DAME,
      "Dame Time",
      input
    )
    expect(r.kind).toBe("ineligible")
    if (r.kind === "ineligible") expect(r.error).not.toMatch(/Dame Time is/)
  })

  it("Panini uses the server-verified card label, not a wallet lookup", async () => {
    const calls: { table: string; filters: any[] }[] = []
    const db = fakeDb({ ...happy, collections: { data: [{ slug: "panini_blockchain" }], error: null } }, calls)
    const ok = await checkChallengePin(db, DAME, "Dame Time", {
      ...input,
      collectionId: PANINI_COLLECTION_ID,
      paniniPlayerName: "Damian Lillard",
    })
    expect(ok.kind).toBe("eligible")
    expect(calls.some((c) => c.table === "wallet_moments_cache")).toBe(false)
    const no = await checkChallengePin(db, DAME, "Dame Time", {
      ...input,
      collectionId: PANINI_COLLECTION_ID,
      paniniPlayerName: "Jrue Holiday",
    })
    expect(no.kind).toBe("ineligible")
  })
})
