import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/bots/discord/register.
// authed(req) accepts `Bearer INGEST_SECRET_TOKEN` or `Bearer CRON_SECRET` (read
// at call time) → 401 otherwise, before any Discord API PUT. With auth passing
// but missing DISCORD_APPLICATION_ID / DISCORD_BOT_TOKEN it 500s. We pin both
// fail-closed branches.

vi.mock("@/lib/alerts/discord-commands", () => ({ COMMANDS: [] }))

import { POST } from "@/app/api/bots/discord/register/route"

const TOKEN = "test-ingest-token"

function req(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/bots/discord/register", { method: "POST", headers })
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
  delete process.env.DISCORD_APPLICATION_ID
  delete process.env.DISCORD_BOT_TOKEN
})
afterEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})

describe("POST /api/bots/discord/register", () => {
  it("401s without auth", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong"))).status).toBe(401)
  })

  it("500s (authed) when the Discord env is missing", async () => {
    const res = await POST(req(`Bearer ${TOKEN}`))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("missing discord env")
  })

  // ── success path ─────────────────────────────────────────────────────────
  // Authed + Discord env present → the route PUTs the COMMANDS array to the
  // Discord API and returns the registered command names (never the token).
  it("200s and returns registered command names when authed with Discord env", async () => {
    process.env.DISCORD_APPLICATION_ID = "app123"
    process.env.DISCORD_BOT_TOKEN = "bot-token"
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => [{ name: "soldpacks" }, { name: "link" }],
    })) as any
    try {
      const res = await POST(req(`Bearer ${TOKEN}`))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.status).toBe(200)
      expect(body.registered).toContain("soldpacks")
      expect(body.guildCleared).toBeNull()
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
