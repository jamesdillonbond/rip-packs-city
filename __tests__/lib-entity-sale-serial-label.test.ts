import { describe, it, expect } from "vitest"
import { saleSerialLabel } from "@/lib/entity/sale-serial-label"

describe("saleSerialLabel", () => {
  it("a resolved serial reads #N", () => {
    expect(saleSerialLabel({ serial_number: 7 })).toEqual({ text: "#7", resolved: true })
  })

  it("⛔ an edition with no serials reads 'unnumbered', never 'serial unresolved' (Pinnacle Open Editions)", () => {
    expect(saleSerialLabel({ serial_number: null, serial_numbered: false }).text).toBe("unnumbered")
  })

  it("a numbered sale without its serial — or with the flag unknown — stays 'serial unresolved'", () => {
    expect(saleSerialLabel({ serial_number: null, serial_numbered: true }).text).toBe("serial unresolved")
    expect(saleSerialLabel({ serial_number: null }).text).toBe("serial unresolved")
    expect(saleSerialLabel({ serial_number: 0, serial_numbered: null }).text).toBe("serial unresolved")
  })
})
