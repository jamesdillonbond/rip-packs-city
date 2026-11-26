import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * UFC Strike's lowest Aptos ask on the edition page (2026-11-25). Rarible is UFC's only venue on
 * Aptos and almost nothing sells there, so the ask is the only live price evidence. These pin the
 * three states — a failed read and "no listing found" must never read as each other, and neither
 * may publish a number.
 */

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

import { fetchUfcAptosEditionFloor, raribleAptosCollectionUrl } from "@/lib/ufc-aptos-floor"

type Res = { data: unknown; error: unknown }
function fakeDb(byTable: Record<string, Res>) {
  return {
    from(table: string) {
      const res = byTable[table]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {
        select: () => b, eq: () => b, order: () => b, limit: () => b,
        then: (resolve: (r: Res) => unknown) => resolve(res ?? { data: [], error: null }),
      }
      return b
    },
  }
}

const COLL = "0xb149b23d020631337343fae1f1ca16b517d556f9eaf1833d290ae628728e4f44"

describe("fetchUfcAptosEditionFloor — three states", () => {
  it("a live single listing → the floor, its count, APT amount and the Rarible collection link", async () => {
    const db = fakeDb({
      v_ufc_aptos_edition_floor: { data: [{ floor_usd: "4.57", floor_apt: "9.98", single_listings: 3, checked_at: "2026-11-25T20:00:00Z" }], error: null },
      ufc_aptos_collections: { data: [{ aptos_collection_id: COLL }], error: null },
    })
    expect(await fetchUfcAptosEditionFloor("ed-1", db)).toEqual({
      floor: { floorUsd: 4.57, floorApt: 9.98, singleListings: 3, checkedAt: "2026-11-25T20:00:00Z", raribleUrl: `https://rarible.com/collection/aptos/${COLL}/items` },
      ok: true,
    })
  })

  it("no listing row → ok with no floor (renders nothing, never 'none listed')", async () => {
    const db = fakeDb({ v_ufc_aptos_edition_floor: { data: [], error: null } })
    expect(await fetchUfcAptosEditionFloor("ed-1", db)).toEqual({ floor: null, ok: true })
  })

  it("only bundled listings (floor_usd NULL) → no floor, never a $0 ask", async () => {
    const db = fakeDb({ v_ufc_aptos_edition_floor: { data: [{ floor_usd: null, floor_apt: null, single_listings: 0, checked_at: "2026-11-25T20:00:00Z" }], error: null } })
    expect(await fetchUfcAptosEditionFloor("ed-1", db)).toEqual({ floor: null, ok: true })
  })

  it("a failed floor read is ok:false — never 'no ask'", async () => {
    const db = fakeDb({ v_ufc_aptos_edition_floor: { data: null, error: { message: "timeout" } } })
    expect(await fetchUfcAptosEditionFloor("ed-1", db)).toEqual({ floor: null, ok: false })
  })

  it("a failed collection read drops only the link, not the ask", async () => {
    const db = fakeDb({
      v_ufc_aptos_edition_floor: { data: [{ floor_usd: 3, floor_apt: 6.5, single_listings: 1, checked_at: null }], error: null },
      ufc_aptos_collections: { data: null, error: { message: "boom" } },
    })
    const r = await fetchUfcAptosEditionFloor("ed-1", db)
    expect(r.ok).toBe(true)
    expect(r.floor?.floorUsd).toBe(3)
    expect(r.floor?.raribleUrl).toBeNull()
  })
})

describe("raribleAptosCollectionUrl", () => {
  it("builds the collection page (per-token links 404 for real tokens) and refuses a non-address", () => {
    expect(raribleAptosCollectionUrl(COLL)).toBe(`https://rarible.com/collection/aptos/${COLL}/items`)
    expect(raribleAptosCollectionUrl("javascript:alert(1)")).toBeNull()
    expect(raribleAptosCollectionUrl(null)).toBeNull()
  })
})

describe("edition page wiring", () => {
  const page = readFileSync(join(process.cwd(), "app/(collections)/[collection]/edition/[slug]/page.tsx"), "utf8")
  it("renders the Aptos ask only for UFC and only when a floor exists", () => {
    expect(page).toMatch(/isUfc && ufcFloorRes\.floor && \(/)
    expect(page).toContain('label="Lowest ask · Aptos"')
  })
  it("hides the Flow 'UFC ask' tile on UFC — the Flow marketplace closed, so it could only ever show a dash", () => {
    expect(page).toMatch(/\{!isUfc && <StatCell\s+label=\{askLabel\}/)
  })
  it("defaults to a FAILED read on UFC, so a fan-out throw never reads as no ask", () => {
    expect(page).toMatch(/let ufcFloorRes: \{ floor: UfcAptosFloor \| null; ok: boolean \} = \{ floor: null, ok: !isUfc \}/)
  })
})
