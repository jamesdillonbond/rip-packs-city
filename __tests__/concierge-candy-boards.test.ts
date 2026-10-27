// 2026-10-26 (Candy ↔ Top Shot parity) — lib/concierge/candy-boards.ts.
// Each of these tools used to answer a Candy question from a Top Shot / Flow table:
// special-serial owners with Top Shot rows (substitution), pack value as "no buyable packs"
// (pack_table_rows holds no Candy row), set completion by resolving a base58 wallet as a Top
// Shot username. The pins hold the honest shapes: failed ≠ empty, verbatim keys, no confidence.

import { describe, it, expect } from "vitest"
import {
  resolveCandyWallet,
  readCandySetCompletionForConcierge,
  readCandyPackMarketForConcierge,
  readCandySpecialSerialsForConcierge,
} from "@/lib/concierge/candy-boards"

const SOL = "2srdg8i14ZCnmMVUZ4wVUJGkuiwSLnNTGaL1REFGtiZ3"
const BASE = "https://t"

function jsonFetch(body: unknown, status = 200) {
  const calls: string[] = []
  const f = (async (url: string) => {
    calls.push(String(url))
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }) as unknown as typeof fetch
  return { f, calls }
}

describe("resolveCandyWallet", () => {
  it("passes a base58 key through VERBATIM (case kept, no 0x)", async () => {
    const r = await resolveCandyWallet(`  ${SOL} `)
    expect(r).toEqual({ kind: "wallet", wallet: SOL, typed: SOL, via: "address" })
  })
  it("a Top Shot username / 0x wallet is not a Candy collector", async () => {
    expect((await resolveCandyWallet("somecollector")).kind).toBe("not_candy")
    expect((await resolveCandyWallet("0xbd94cade097e50ac")).kind).toBe("not_candy")
  })
  it("a FAILED SNS lookup is reported as failed, never as 'no such name'", async () => {
    const f = (async () => { throw new Error("down") }) as unknown as typeof fetch
    const r = await resolveCandyWallet("alice.sol", f)
    expect(r.kind).toBe("error")
    expect(JSON.parse((r as { payload: string }).payload).status).toBe("name_lookup_failed")
  })
})

describe("readCandySetCompletionForConcierge", () => {
  it("reads /api/candy-set-progress with the wallet verbatim and drops FMV confidence", async () => {
    const { f, calls } = jsonFetch({
      asksAsOf: "2026-10-26T20:00:00Z",
      sets: [{
        setName: "2026 MLB Base Series ICONs", totalEditions: 100, ownedCount: 40, missingCount: 60, listedCount: 58,
        completionPct: 40, totalMissingCost: 300.5, costConfidence: "mixed", lowestSingleAsk: 2.1,
        bottleneckPrice: null, ownedPrintings: 41, totalPrintings: 125,
        missing: [{ playerName: "Paul Skenes", tier: "COMMON", lowestAsk: 9.5, fmv: 9, fmvConfidence: "HIGH", serialNumber: null, topshotUrl: "/candy-mlb/edition/paul-skenes" }],
      }],
    })
    const out = await readCandySetCompletionForConcierge(BASE, SOL, f)
    expect(calls[0]).toBe(`${BASE}/api/candy-set-progress?wallet=${SOL}`)
    const r = JSON.parse(out)
    expect(r).toMatchObject({ status: "ok", wallet: SOL, collection: "candy-mlb" })
    expect(r.sets[0]).toMatchObject({ slots_owned: 40, slots_missing: 60, cost_to_finish_usd: 300.5, every_missing_slot_priced: false })
    expect(out).not.toContain("HIGH")
    expect(out).not.toMatch(/confidence/i)
  })
  it("a failed read is an error, never 'no set progress'", async () => {
    const { f } = jsonFetch({ error: "x" }, 503)
    expect(JSON.parse(await readCandySetCompletionForConcierge(BASE, SOL, f)).status).toBe("error")
  })
})

describe("readCandyPackMarketForConcierge", () => {
  const body = (typical: number, mean: number) => ({
    product: { name: "2026 MLB Base Series ICONs", retailUsd: 10, declaredSupply: 2500 },
    supply: { indexed: 2501, treasuryHeld: 1600, collectorHeld: 400, collectorWallets: 120, burnt: 500 },
    market: { confirmedFloorUsd: 12, confirmedAsks: 9, confirmedWithinHours: 12, sales7d: 0 },
    ev: { iconSlots: 3, rainbowChance: 0.1, packCostUsd: 10, typicalPullUsd: typical, actualEvUsd: mean, note: null },
    asks_error: false,
  })
  it("a mean edge carried by the chase is positive_on_mean_only, never a pack that usually pays", async () => {
    const r = JSON.parse(await readCandyPackMarketForConcierge(BASE, jsonFetch(body(5, 15)).f))
    expect(r.status).toBe("ok")
    expect(r.rip_verdict).toBe("positive_on_mean_only")
    expect(r.market.confirmed_floor_ask_usd).toBe(12)
  })
  it("typical pull at or above the floor is the only 'usually pays' verdict", async () => {
    expect(JSON.parse(await readCandyPackMarketForConcierge(BASE, jsonFetch(body(13, 15)).f)).rip_verdict).toBe("typical_pack_beats_cost")
  })
  it("a failed read is an error, never 'no packs'", async () => {
    expect(JSON.parse(await readCandyPackMarketForConcierge(BASE, jsonFetch({}, 500).f)).status).toBe("error")
  })
})

describe("readCandySpecialSerialsForConcierge", () => {
  function db(rows: unknown[] | null, error: unknown = null) {
    const seen: { eq: Array<[string, unknown]> } = { eq: [] }
    const q: Record<string, unknown> = {}
    for (const m of ["select", "ilike", "order"]) q[m] = () => q
    q.eq = (c: string, v: unknown) => { seen.eq.push([c, v]); return q }
    q.range = async () => ({ data: rows, error })
    return { client: { from: (t: string) => { expect(t).toBe("candy_special_serials_board"); return q } }, seen }
  }
  const ROWS = [
    { external_id: "a", player_name: "A", kind: "first_mint", serial_number: 1, owner: SOL, is_treasury: false, fmv_usd: 50 },
    { external_id: "a", player_name: "A", kind: "last_mint", serial_number: 250, owner: "Treasury1111111111111111111111111111111111", is_treasury: true, fmv_usd: 50 },
    { external_id: "b", player_name: "B", kind: "jersey_match", serial_number: 17, owner: SOL, is_treasury: false, fmv_usd: 10 },
  ]
  it("maps Top Shot's tags to Candy's kinds ('perfect' = last_mint)", async () => {
    const r = JSON.parse(await readCandySpecialSerialsForConcierge(db(ROWS).client, BASE, { tag: "perfect" }))
    expect(r.rows.map((x: { kind: string }) => x.kind)).toEqual(["last_mint"])
    expect(r.rows[0]).toMatchObject({ holder: null, still_with_candy_unsold: true })
  })
  it("filters a holder VERBATIM", async () => {
    const d = db(ROWS)
    await readCandySpecialSerialsForConcierge(d.client, BASE, { holder: SOL })
    expect(d.seen.eq).toContainEqual(["owner", SOL])
  })
  it("a failed read is an error, never 'none'", async () => {
    expect(JSON.parse(await readCandySpecialSerialsForConcierge(db(null, { message: "x" }).client, BASE, {})).status).toBe("error")
  })
})
