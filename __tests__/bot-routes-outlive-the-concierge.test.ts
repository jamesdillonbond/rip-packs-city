import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// ⚠ A CALLER THAT DIES WITH ITS CALLEE HAS NO FAILURE PATH AT ALL.
//
// Both bot routes DEFER: they acknowledge immediately and finish the work in
// `after()`, so the only thing that ever reaches the user is the message sent
// at the END of that work — a follow-up PATCH on Discord, a sendMessage on
// Telegram. If the lambda is killed first, neither is sent, and the bot's own
// try/catch cannot save it because a killed lambda runs no catch block.
//
// All three routes carried `maxDuration = 60` — the bots and the
// /api/support-chat they call. So whenever the concierge ran long, the bot was
// killed at the very moment its own error handling would have fired. Measured
// live 2026-08-16: `POST /api/bots/discord 200 [error] Task timed out after 60
// seconds`, and the user sat on "Rip Packs City is thinking…" for eight
// minutes. Telegram fails the same way but as pure silence, which is harder to
// notice and reads exactly like a dead bot.
//
// This is a source guard because the property is a RELATIONSHIP between three
// module-level constants in three files. No type can express it, and no runtime
// test can observe a Vercel lambda kill.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8")
}

/** The `export const maxDuration = N` a route declares. */
function maxDuration(rel: string): number {
  const m = read(rel).match(/export const maxDuration\s*=\s*(\d+)/)
  if (!m) throw new Error(`no maxDuration in ${rel}`)
  return Number(m[1])
}

const DISCORD = "app/api/bots/discord/route.ts"
const TELEGRAM = "app/api/bots/telegram/route.ts"
const SUPPORT_CHAT = "app/api/support-chat/route.ts"
const BRIDGE = "lib/alerts/concierge-bridge.ts"

describe("bot routes must outlive the concierge they call", () => {
  const callee = maxDuration(SUPPORT_CHAT)

  it("reads a real budget from every route (not vacuous)", () => {
    expect(callee).toBeGreaterThan(0)
    expect(maxDuration(DISCORD)).toBeGreaterThan(0)
    expect(maxDuration(TELEGRAM)).toBeGreaterThan(0)
  })

  for (const bot of [DISCORD, TELEGRAM]) {
    it(`${bot} outlives /api/support-chat`, () => {
      // Strictly greater: equal budgets are the original bug, because the bot
      // starts FIRST and so dies first or simultaneously.
      expect(maxDuration(bot)).toBeGreaterThan(callee)
    })

    it(`${bot} leaves room to actually send the reply after the callee gives up`, () => {
      // The callee can burn its whole budget and still return a 504. The bot
      // then has to send its message, which needs real headroom, not a
      // millisecond. 15s is a deliberately loose floor.
      expect(maxDuration(bot) - callee).toBeGreaterThanOrEqual(15)
    })
  }

  it("the bridge bounds its fetch, so a hung socket cannot outlive the budget", () => {
    // Without this the bridge waits forever on a callee that never answers,
    // and the bot's larger maxDuration only buys a longer hang.
    const src = read(BRIDGE)
    expect(src).toMatch(/AbortSignal\.timeout\(/)
  })

  it("the bridge timeout sits between the callee's budget and the bots'", () => {
    const m = read(BRIDGE).match(/const CONCIERGE_TIMEOUT_MS\s*=\s*([\d_]+)/)
    expect(m).not.toBeNull()
    const bridgeMs = Number(m![1].replace(/_/g, "")) / 1000
    // Above the callee's ceiling, so a legitimately slow-but-completing run is
    // never cut off...
    expect(bridgeMs).toBeGreaterThan(callee)
    // ...and below both bots', so the abort fires while they are still alive to
    // report it.
    expect(bridgeMs).toBeLessThan(maxDuration(DISCORD))
    expect(bridgeMs).toBeLessThan(maxDuration(TELEGRAM))
  })
})
