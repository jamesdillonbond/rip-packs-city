import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { installFetchMock, jsonRoute } from "./helpers/route-harness"

// Deep-drive of the Discord Interactions endpoint. Pins the security-critical
// signature gate (Discord rejects the endpoint at registration if a bad
// signature isn't 401'd), the PING/PONG handshake, each slash-command arm's
// inline-vs-deferred response contract, and the deferred follow-up webhook
// PATCH (the actual work for /soldpacks and /ask happens in after()).

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sigValid: true,
  linkResult: { ok: true } as { ok: boolean } | null,
  conciergeOn: true,
  conciergeAnswer: "Here's your answer." as string | null,
  wallet: "0xbd94cade097e50ac" as string | null,
  packReport: { moments: 3 } as unknown,
  owner: { linked: true, owner_key: "collector" } as { linked: boolean; owner_key: string | null },
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})
vi.mock("@/lib/alerts/discord-verify", () => ({
  verifyDiscordRequest: () => state.sigValid,
}))
vi.mock("@/lib/alerts", () => ({
  claimChannelLink: async () => state.linkResult,
  resolveChannelOwner: async () => state.owner,
  resolveChannelOwnerUsername: async () => state.owner.owner_key,
}))
vi.mock("@/lib/alerts/concierge-bridge", () => ({
  conciergeEnabled: () => state.conciergeOn,
  conciergeReply: async () => state.conciergeAnswer,
}))
vi.mock("@/lib/alerts/soldpacks", () => ({
  resolveWalletForChannel: async () => state.wallet,
  getPackReport: async () => state.packReport,
  formatPackReportDiscordEmbed: (r: unknown) => ({ title: "Pack report", raw: r }),
}))
vi.mock("@/lib/alerts/discord-commands", () => ({ COMMANDS: [] }))

const { POST } = await import("@/app/api/bots/discord/route")

function post(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://t/api/bots/discord", {
    method: "POST",
    headers: new Headers({
      "x-signature-ed25519": "sig",
      "x-signature-timestamp": "ts",
      ...headers,
    }),
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  state.afterCbs.length = 0
  state.sigValid = true
  state.conciergeOn = true
  state.conciergeAnswer = "Here's your answer."
  state.wallet = "0xbd94cade097e50ac"
  state.linkResult = { ok: true }
  state.owner = { linked: true, owner_key: "collector" }
  process.env.DISCORD_APPLICATION_ID = "app-123"
  fetchMock = installFetchMock([jsonRoute("discord.com/api", { id: "msg-1" })])
})

describe("bots/discord — gate + handshake", () => {
  it("401s on an invalid Ed25519 signature before any work", async () => {
    state.sigValid = false
    const res = await POST(post({ type: 1 }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toContain("signature")
  })

  it("400s on a malformed body that passes signature verification", async () => {
    const res = await POST(post("not json{{"))
    expect(res.status).toBe(400)
  })

  it("answers a PING with a PONG", async () => {
    const res = await POST(post({ type: 1 }))
    expect((await res.json())).toEqual({ type: 1 })
  })
})

describe("bots/discord — inline commands", () => {
  it("/alerts replies ephemerally with the manage link", async () => {
    const res = await POST(post({ type: 2, data: { name: "alerts" }, member: { user: { id: "u1" } } }))
    const body = await res.json()
    expect(body.type).toBe(4)
    expect(body.data.content).toContain("rippackscity.com/alerts")
    expect(body.data.flags).toBe(64) // ephemeral
  })

  it("/link claims the channel link and confirms on success", async () => {
    const res = await POST(
      post({
        type: 2,
        data: { name: "link", options: [{ name: "code", value: "ABC123" }] },
        member: { user: { id: "u1", username: "dave" } },
      }),
    )
    expect((await res.json()).data.content).toContain("Linked!")
  })

  it("/link surfaces an invalid/expired code", async () => {
    state.linkResult = { ok: false }
    const res = await POST(
      post({
        type: 2,
        data: { name: "link", options: [{ name: "code", value: "BAD" }] },
        member: { user: { id: "u1" } },
      }),
    )
    expect((await res.json()).data.content).toContain("invalid or expired")
  })

  it("/link without a code shows usage", async () => {
    const res = await POST(post({ type: 2, data: { name: "link" }, member: { user: { id: "u1" } } }))
    expect((await res.json()).data.content).toContain("Usage: /link")
  })

  it("an unknown command replies with the fallback", async () => {
    const res = await POST(post({ type: 2, data: { name: "whoami" }, member: { user: { id: "u1" } } }))
    expect((await res.json()).data.content).toContain("Unknown command")
  })
})

describe("bots/discord — deferred commands", () => {
  it("/soldpacks defers, then follows up with the pack-report embed", async () => {
    const res = await POST(
      post({
        type: 2,
        data: { name: "soldpacks", options: [{ name: "wallet", value: "0xbd94cade097e50ac" }] },
        member: { user: { id: "u1" } },
        token: "interaction-token",
        application_id: "app-123",
      }),
    )
    // Inline response is a deferred ack.
    expect((await res.json()).type).toBe(5)
    await runDeferred()

    const patch = fetchMock!.calls.find((c) => c.url.includes("/webhooks/") && c.init?.method === "PATCH")
    expect(patch).toBeTruthy()
    const payload = JSON.parse(String(patch!.init?.body))
    expect(payload.embeds[0]).toMatchObject({ title: "Pack report" })
  })

  it("/soldpacks with no resolvable wallet follows up asking for one", async () => {
    state.wallet = null
    await POST(
      post({
        type: 2,
        data: { name: "soldpacks", options: [] },
        member: { user: { id: "u1" } },
        token: "tok",
      }),
    )
    await runDeferred()
    const patch = fetchMock!.calls.find((c) => c.init?.method === "PATCH")
    expect(String(JSON.parse(String(patch!.init?.body)).content)).toContain("Send a wallet")
  })

  it("/ask defers and follows up with the concierge reply when enabled", async () => {
    const res = await POST(
      post({
        type: 2,
        data: { name: "ask", options: [{ name: "question", value: "what's my FMV?" }] },
        member: { user: { id: "u1" } },
        token: "tok",
      }),
    )
    expect((await res.json()).type).toBe(5)
    await runDeferred()
    const patch = fetchMock!.calls.find((c) => c.init?.method === "PATCH")
    expect(JSON.parse(String(patch!.init?.body)).content).toBe("Here's your answer.")
  })

  it("/ask replies inline (no defer) when the concierge is switched off", async () => {
    state.conciergeOn = false
    const res = await POST(
      post({
        type: 2,
        data: { name: "ask", options: [{ name: "question", value: "hi" }] },
        member: { user: { id: "u1" } },
        token: "tok",
      }),
    )
    const body = await res.json()
    expect(body.type).toBe(4) // inline ephemeral, not deferred
    expect(body.data.content).toContain("isn't switched on")
    expect(state.afterCbs).toHaveLength(0)
  })

  it("/ask truncates a reply over Discord's 2000-char cap", async () => {
    state.conciergeAnswer = "x".repeat(2500)
    await POST(
      post({
        type: 2,
        data: { name: "ask", options: [{ name: "question", value: "long" }] },
        member: { user: { id: "u1" } },
        token: "tok",
      }),
    )
    await runDeferred()
    const patch = fetchMock!.calls.find((c) => c.init?.method === "PATCH")
    const content = JSON.parse(String(patch!.init?.body)).content as string
    expect(content.length).toBeLessThanOrEqual(2000)
    expect(content.endsWith("…")).toBe(true)
  })
})
