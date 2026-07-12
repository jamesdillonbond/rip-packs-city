import { describe, it, expect } from "vitest"
import {
  parsePinnacleTraits,
  buildEditionKey,
  isLocked,
  getSerial,
} from "@/lib/pinnacle/flowty"

// Parsing Flowty Pinnacle trait arrays into the typed shape + the composite
// edition key (royalty:variant:printing). buildEditionKey must strip the
// bracketed royalty code — a wrong key breaks the Pinnacle FMV join.

function traits(over: Partial<Record<string, string>> = {}) {
  const arr = Object.entries(over).map(([name, value]) => ({ name, value: value! }))
  return parsePinnacleTraits(arr)
}

describe("parsePinnacleTraits", () => {
  it("fills defaults for missing traits", () => {
    const t = parsePinnacleTraits([])
    expect(t.Variant).toBe("Standard")
    expect(t.SetName).toBe("Unknown")
    expect(t.EditionType).toBe("Open Edition")
    expect(t.Printing).toBe("1")
    expect(t.SerialNumber).toBeNull()
  })

  it("reads provided values", () => {
    const t = traits({ Variant: "Golden", SerialNumber: "7" })
    expect(t.Variant).toBe("Golden")
    expect(t.SerialNumber).toBe("7")
  })
})

describe("buildEditionKey", () => {
  it("strips brackets off the royalty code and joins royalty:variant:printing", () => {
    const t = traits({ RoyaltyCodes: "[WDAS-OEV1-LION]", Variant: "Digital Display", Printing: "1" })
    expect(buildEditionKey(t)).toBe("WDAS-OEV1-LION:Digital Display:1")
  })
})

describe("isLocked", () => {
  it("false when no maturity date", () => {
    expect(isLocked(traits({}))).toBe(false)
  })
  it("true for a far-future maturity, false for a past one", () => {
    expect(isLocked(traits({ MaturityDate: "32503680000" }))).toBe(true) // year 3000 (epoch secs)
    expect(isLocked(traits({ MaturityDate: "946684800" }))).toBe(false) // year 2000
  })
})

describe("getSerial", () => {
  it("parses the serial number, null when absent / non-numeric", () => {
    expect(getSerial(traits({ SerialNumber: "42" }))).toBe(42)
    expect(getSerial(traits({}))).toBeNull()
    expect(getSerial(traits({ SerialNumber: "abc" }))).toBeNull()
  })
})
