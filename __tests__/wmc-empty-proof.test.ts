import { describe, it, expect, vi, afterEach } from "vitest"
import { classifyProofResult, proveCollectionEmpty, readCollectionCount, EMPTY_PROOF_SCRIPTS } from "@/lib/chains/flow/wmc-empty-proof"

// The proof scripts were run against mainnet 2026-10-14 (pg_net, sealed block):
// emptied wallets 0x8e655887a360cc3f (Top Shot) and 0x6d1f8c18412c6abc (UFC) → 0;
// holders 0xbd94cade097e50ac (Top Shot) → 15606 and 0x70597013b85e6443 (UFC) → 4;
// 0x1d7e57aa55817448 (no collection) → -1 on both.

afterEach(() => vi.unstubAllGlobals())

const cdc = (o: unknown) => ({ ok: true, status: 200, text: async () => Buffer.from(JSON.stringify(o)).toString("base64") })

describe("classifyProofResult", () => {
  it("0 is proof of empty; n > 0 is not empty; -1 is no collection", () => {
    expect(classifyProofResult({ type: "Int", value: "0" })).toBe("proven_empty")
    expect(classifyProofResult({ type: "Int", value: "15606" })).toBe("not_empty")
    expect(classifyProofResult({ type: "Int", value: "-1" })).toBe("no_collection")
  })
  it("anything that is not a JSON-Cadence Int is a failed read, never empty", () => {
    for (const bad of [null, {}, { type: "Array", value: [] }, { type: "Int", value: "" }, { type: "Int", value: 0 }, { type: "String", value: "0" }]) {
      expect(classifyProofResult(bad)).toBe("read_failed")
    }
  })
})

describe("proveCollectionEmpty", () => {
  it("has a script only for collections whose custody is wholly in the holder's collection", () => {
    expect(Object.keys(EMPTY_PROOF_SCRIPTS).sort()).toEqual(["nba_top_shot", "ufc_strike"])
    expect(EMPTY_PROOF_SCRIPTS.nfl_all_day).toBeUndefined()
    for (const s of Object.values(EMPTY_PROOF_SCRIPTS)) {
      expect(s).toContain("if col == nil { return -1 }")
      expect(s).toContain("getIDs().length")
    }
  })
  it("returns no_proof_script without touching the network for other collections", async () => {
    const f = vi.fn()
    vi.stubGlobal("fetch", f)
    expect(await proveCollectionEmpty("0x01", "nfl_all_day")).toBe("no_proof_script")
    expect(f).not.toHaveBeenCalled()
  })
  it("reads a proven empty collection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(cdc({ type: "Int", value: "0" })))
    expect(await proveCollectionEmpty("0x8e655887a360cc3f", "nba_top_shot")).toBe("proven_empty")
  })
  it("an HTTP error, a thrown fetch or an unparseable body are read_failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "boom" }))
    expect(await proveCollectionEmpty("0x01", "ufc_strike")).toBe("read_failed")
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")))
    expect(await proveCollectionEmpty("0x01", "ufc_strike")).toBe("read_failed")
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "not base64 json" }))
    expect(await proveCollectionEmpty("0x01", "ufc_strike")).toBe("read_failed")
  })
})

describe("readCollectionCount", () => {
  it("returns the count, and null for no collection / failed read / no script", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(cdc({ type: "Int", value: "74" })))
    expect(await readCollectionCount("0x0e4ba505d4482579", "nba_top_shot")).toBe(74)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(cdc({ type: "Int", value: "-1" })))
    expect(await readCollectionCount("0x01", "nba_top_shot")).toBeNull()
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")))
    expect(await readCollectionCount("0x01", "ufc_strike")).toBeNull()
    expect(await readCollectionCount("0x01", "nfl_all_day")).toBeNull()
  })
})
