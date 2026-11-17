import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/bots/discord (Discord Interactions).
// Every request's Ed25519 signature is verified against DISCORD_PUBLIC_KEY
// before any work; a missing/invalid signature → 401. Mock the heavy lib deps
// so the module imports cleanly and force verifyDiscordRequest to reject. We pin
// the signature guard (Discord requires this to register the endpoint).

vi.mock("@/lib/alerts/discord-verify", () => ({ verifyDiscordRequest: () => false }))
vi.mock("@/lib/alerts", () => ({
  claimChannelLink: async () => ({ ok: true }),
  resolveChannelOwner: async () => null,
  resolveChannelOwnerUsername: async () => null,
}))
vi.mock("@/lib/alerts/concierge-bridge", () => ({
  conciergeReply: async () => "",
  conciergeEnabled: () => false,
}))
vi.mock("@/lib/alerts/soldpacks", () => ({
  resolveWalletForChannel: async () => null,
  getPackReport: async () => null,
  formatPackReportDiscordEmbed: () => ({}),
}))
vi.mock("@/lib/alerts/discord-commands", () => ({ COMMANDS: [] }))

import { POST } from "@/app/api/bots/discord/route"

function req(body = "{}"): NextRequest {
  return new NextRequest("https://t/api/bots/discord", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })
}

describe("POST /api/bots/discord", () => {
  it("401s on an invalid/missing request signature", async () => {
    const res = await POST(req())
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("invalid request signature")
  })
})
