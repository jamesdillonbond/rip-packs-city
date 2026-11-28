import { describe, it, expect } from "vitest"
import { mergeUfcAptosAnswers, type UfcAptosHolding } from "@/lib/ufc-aptos"

// 2026-11-27: a collector's own Flow UFC binder reads its LINKED Aptos accounts and their separately SAVED Aptos
// account. The two often overlap (the saved account IS the linked one), so the merge must keep each Moment once
// and compute totals from the merged list — adding the two answers' totals would double a collector's Aptos value.

const m = (id: string, fmv: number | null): UfcAptosHolding => ({
  token_data_id: id,
  edition_id: null,
  name: null,
  player_name: null,
  set_name: null,
  tier: null,
  serial_number: null,
  circulation_count: null,
  thumbnail_url: null,
  fmv_usd: fmv,
})

describe("mergeUfcAptosAnswers", () => {
  it("keeps an overlapping Moment once and totals the merged list", () => {
    const linked = { linked: true, moments: [m("a", 10), m("b", 5)] }
    const saved = { linked: true, moments: [m("b", 5), m("c", 2.5)] }
    const { state, moments } = mergeUfcAptosAnswers([linked, saved], false)
    expect(moments.map((x) => x.token_data_id)).toEqual(["a", "b", "c"])
    expect(state).toEqual({ status: "ok", count: 3, totalFmv: 17.5, unpriced: 0, capped: false, direct: false })
  })

  it("counts an unpriced Moment without valuing it; nothing priced is a null total, never $0", () => {
    expect(mergeUfcAptosAnswers([{ linked: true, moments: [m("a", 4), m("b", null)] }], true).state)
      .toEqual({ status: "ok", count: 2, totalFmv: 4, unpriced: 1, capped: false, direct: true })
    expect(mergeUfcAptosAnswers([{ linked: true, moments: [m("a", null)] }], true).state)
      .toMatchObject({ status: "ok", count: 1, totalFmv: null, unpriced: 1 })
  })

  it("a $0 FMV is priced (the route's rule), and totals are rounded to cents", () => {
    expect(mergeUfcAptosAnswers([{ linked: true, moments: [m("a", 0), m("b", 0.1), m("c", 0.2)] }], false).state)
      .toMatchObject({ count: 3, unpriced: 0, totalFmv: 0.3 })
  })

  it("an unlinked or empty answer contributes nothing; all empty is 'none'", () => {
    expect(mergeUfcAptosAnswers([{ linked: false }, { linked: true, moments: [] }], false).state).toEqual({ status: "none", direct: false })
    expect(mergeUfcAptosAnswers([{ linked: false, moments: [m("x", 9)] }, { linked: true, moments: [m("a", 1)] }], false).moments.map((x) => x.token_data_id))
      .toEqual(["a"])
  })

  it("capped if any answer is capped", () => {
    expect(mergeUfcAptosAnswers([{ linked: true, moments: [m("a", 1)] }, { linked: true, capped: true, moments: [] }], false).state)
      .toMatchObject({ capped: true })
  })
})

// The saved Aptos account is the VIEWER's. It may only join the binder when the binder shows the viewer's own
// saved Flow wallet — a looked-up wallet must never borrow it. Pinned at the source, where the gate lives.
import { readFileSync } from "fs"
import { join } from "path"
describe("the binder adds a saved Aptos account only to the collector's own Flow binder", () => {
  const src = readFileSync(join(process.cwd(), "app/(collections)/[collection]/collection/CollectionTabClient.tsx"), "utf8")
  it("gates on a signed-in session and the wallet on screen being the saved one", () => {
    const gate = src.slice(src.indexOf("const ownFlowBinder ="), src.indexOf("const [savedUfcAptos"))
    expect(gate).toMatch(/sessionOwner\.userId/)
    expect(gate).toMatch(/!sessionOwner\.degraded/)
    expect(gate).toMatch(/activeWallet\.toLowerCase\(\) === savedWalletLoaded\.toLowerCase\(\)/)
    expect(src).toMatch(/const ufcAptosExtra = ownFlowBinder && savedUfcAptos \? savedUfcAptos : ""/)
  })
})
