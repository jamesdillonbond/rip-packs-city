import { describe, it, expect } from "vitest"
import { COMMANDS } from "@/lib/alerts/discord-commands"

// discord-commands.ts is the single source of truth for the Discord slash-command
// schema (shared by the interactions + registration routes). It's a static array,
// so we pin the command set, their DM-enabling contexts ([0,1,2]), and the
// required/typed option shapes that the register route serializes to Discord.

describe("discord COMMANDS schema", () => {
  it("exports exactly the four expected commands in order", () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(["link", "soldpacks", "alerts", "ask"])
  })

  it("every command allows the three DM/guild contexts [0,1,2]", () => {
    for (const c of COMMANDS) {
      expect(c.contexts).toEqual([0, 1, 2])
    }
  })

  it("link requires a STRING code option", () => {
    const link = COMMANDS.find((c) => c.name === "link")!
    expect(link.options).toEqual([
      { name: "code", description: expect.any(String), type: 3, required: true },
    ])
  })

  it("soldpacks has an optional STRING wallet option", () => {
    const sp = COMMANDS.find((c) => c.name === "soldpacks")!
    expect(sp.options?.[0]).toMatchObject({ name: "wallet", type: 3, required: false })
  })

  it("ask requires a STRING question option", () => {
    const ask = COMMANDS.find((c) => c.name === "ask")!
    expect(ask.options?.[0]).toMatchObject({ name: "question", type: 3, required: true })
  })

  it("alerts is an option-less command", () => {
    const alerts = COMMANDS.find((c) => c.name === "alerts")!
    expect((alerts as { options?: unknown }).options).toBeUndefined()
  })

  it("every command carries a non-empty description", () => {
    for (const c of COMMANDS) {
      expect(typeof c.description).toBe("string")
      expect(c.description.length).toBeGreaterThan(0)
    }
  })
})
