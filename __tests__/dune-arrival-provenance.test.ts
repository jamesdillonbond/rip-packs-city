import { describe, it, expect } from "vitest"
import { mapProvenanceRow, padFlowAddress } from "@/lib/dune/arrival-provenance"

const TX = "a349d590be19bbff6c639e109abe275a8c2b017990dbd7215896e1275ae03439"

describe("arrival provenance row mapping (Dune query 9129294)", () => {
  it("left-pads an address Dune printed without its leading zero", () => {
    expect(padFlowAddress("0x75491a006a56a2f")).toBe("0x075491a006a56a2f")
    expect(padFlowAddress("0x026ae10d4d65856f")).toBe("0x026ae10d4d65856f")
  })

  it("refuses a value that is not a Flow address instead of fabricating one", () => {
    expect(padFlowAddress("0x" + "f".repeat(17))).toBeNull()
    expect(padFlowAddress("not-an-address")).toBeNull()
    expect(padFlowAddress(null)).toBeNull()
  })

  it("maps a marketplace purchase row with its price and seller", () => {
    expect(
      mapProvenanceRow({ id: "25167", w: "0x7e38edfe0510024a", dt: "2023-06-01", h: 1, tx: TX, k: "OC", p: "145", f: "0x2ca8ca67324c4ac" }),
    ).toEqual({
      wallet: "0x7e38edfe0510024a", nft_id: "25167", arrival_tx: TX, arrival_date: "2023-06-01",
      block_height: 1, kind: "OC", price: 145, from_addr: "0x02ca8ca67324c4ac",
    })
  })

  it("keeps a pull with no price as a null price, never a fabricated zero", () => {
    const r = mapProvenanceRow({ id: "1", w: "0x8bc1c0249e2ebb3e", dt: "2021-01-03", h: 2, tx: TX, k: "P", p: null, f: "0xe1f2a091f7bb5245" })
    expect(r?.price).toBeNull()
    expect(r?.kind).toBe("P")
  })

  it("drops rows with an unknown kind or a malformed tx", () => {
    expect(mapProvenanceRow({ id: "1", w: "0x8bc1c0249e2ebb3e", tx: TX, k: "ZZ" })).toBeNull()
    expect(mapProvenanceRow({ id: "1", w: "0x8bc1c0249e2ebb3e", tx: "abc", k: "MP", p: "5" })).toBeNull()
  })
})
