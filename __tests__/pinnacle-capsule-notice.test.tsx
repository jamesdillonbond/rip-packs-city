import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

const read = vi.hoisted(() => ({ value: { ok: true, mintedToBuyers: 5523 } as { ok: true; mintedToBuyers: number } | { ok: false } }))
vi.mock("@/lib/pinnacle/capsule-mints", () => ({ fetchCapsuleMintedToBuyers: async () => read.value }))

import PinnacleCapsuleNotice from "@/components/pinnacle/PinnacleCapsuleNotice"
import { PINNACLE_CAPSULE_DROPS } from "@/lib/pinnacle/capsule-drops"

const MUGS = PINNACLE_CAPSULE_DROPS[0]

describe("PinnacleCapsuleNotice", () => {
  beforeEach(() => { read.value = { ok: true, mintedToBuyers: 5523 } })

  it("says the opens are chasers only and gives the capsule floor", async () => {
    const html = renderToStaticMarkup(await PinnacleCapsuleNotice({ capsule: MUGS }))
    expect(html).toContain("Chaser capsules only")
    expect(html).toContain("Walt Disney Mugs Vol.1")
    expect(html).toContain("At least 5,523")
  })

  it("a failed mint read drops the number instead of printing 0", async () => {
    read.value = { ok: false }
    const html = renderToStaticMarkup(await PinnacleCapsuleNotice({ capsule: MUGS }))
    expect(html).toContain("Chaser capsules only")
    expect(html).not.toContain("At least")
    expect(html).not.toMatch(/\b0 Walt Disney/)
  })
})
