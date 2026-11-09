import { describe, it, expect } from "vitest"
import { volunteeredContactEmail } from "@/lib/concierge/contact-email"

// A signed-out reporter's volunteered address (2026-11-09). The only gate it
// passes before landing on support_conversations.user_email, which shipped-
// notify emails.
describe("volunteeredContactEmail", () => {
  it("accepts one address exactly as the user typed it", () => {
    expect(volunteeredContactEmail("fan@example.com", ["email me at fan@example.com please"])).toBe("fan@example.com")
    expect(volunteeredContactEmail("  Fan@Example.com ", ["FAN@EXAMPLE.COM"])).toBe("Fan@Example.com")
  })

  it("⚠ refuses an address the user never typed — the model relays, it never invents", () => {
    expect(volunteeredContactEmail("fan@example.com", ["tell me when it's fixed"])).toBeNull()
    expect(volunteeredContactEmail("fan@example.com", [])).toBeNull()
  })

  it("refuses anything that is not ONE address", () => {
    const typed = ["a b@x.com; c@y.com <z@w.com> fan@example fan@@example.com"]
    for (const bad of ["a b@x.com", "c@y.com; d@y.com", "<z@w.com>", "fan@example", "fan@@example.com", "", "   ", "x".repeat(250) + "@a.com"]) {
      expect(volunteeredContactEmail(bad, [...typed, bad])).toBeNull()
    }
    for (const bad of [null, undefined, 42, {}]) expect(volunteeredContactEmail(bad, ["fan@example.com"])).toBeNull()
  })
})
