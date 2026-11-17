import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// ⚠ THE ASYMMETRY THIS GUARDS, because it is invisible from the code alone.
//
// Telegram's webhook receives plain text: `app/api/bots/telegram/route.ts`
// routes any non-command message straight to the concierge, so a user can just
// type a question. Discord's endpoint is an INTERACTIONS webhook — it receives
// PING and APPLICATION_COMMAND and nothing else. Ordinary DM messages are
// Gateway events (MESSAGE_CREATE, behind the privileged MESSAGE_CONTENT
// intent) delivered over a persistent websocket, which a serverless deployment
// cannot hold open. So a plain Discord DM produces NO REQUEST TO THIS APP AT
// ALL — the bot does not fail to answer, it never hears it.
//
// That is indistinguishable from a dead bot from the user's side, and it is
// what a real user hit: they messaged the bot on Discord and got silence. The
// alert DM is the surface where a follow-up is most likely to be typed (it is
// the message they are replying to), so it is the one place that must say how
// to reply. Deleting the "/ask" line silently restores the dead-end.
//
// A source guard rather than a runtime assertion: the string lives in a fetch
// body inside a cron route whose delivery path needs a live Discord token, and
// what matters is that the copy is PRESENT in the message we send.

function readSource(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8")
}

// Comment stripper — this file's own explanatory comments quote "/ask", and so
// does the route's. Matching against comments would make every assertion below
// pass on a route that had dropped the user-visible line entirely. (The
// recurring trap in this repo: a guard that greps source for user copy MUST
// strip comments first.)

const ALERTS_SEND = "app/api/cron/alerts-send/route.ts"
const DISCORD_BOT = "app/api/bots/discord/route.ts"
const TELEGRAM_BOT = "app/api/bots/telegram/route.ts"

describe("Discord alert DMs tell the user how to reply", () => {
  it("the Discord DM body mentions /ask", () => {
    const code = stripComments(readSource(ALERTS_SEND))
    const fn = code.slice(code.indexOf("async function sendDiscordGroup"))
    expect(fn).toMatch(/\/ask/)
  })

  it("the guard is not vacuous — the copy is outside comments", () => {
    // Proves stripComments actually ran: the raw file has far more /ask
    // mentions (in the explanatory comment) than the stripped one.
    const raw = readSource(ALERTS_SEND)
    const stripped = stripComments(raw)
    const count = (s: string) => (s.match(/\/ask/g) ?? []).length
    expect(count(raw)).toBeGreaterThan(count(stripped))
    expect(count(stripped)).toBeGreaterThan(0)
  })

  it("the DM says plain messages do not reach the bot", () => {
    const code = stripComments(readSource(ALERTS_SEND))
    const fn = code.slice(code.indexOf("async function sendDiscordGroup"))
    // The reason matters as much as the instruction — without it the user
    // reads "/ask" as one option among several rather than the only one.
    expect(fn).toMatch(/don't reach|do not reach|only.*slash/i)
  })

  it("Telegram deliberately carries no such line — its webhook does take plain text", () => {
    // Pins the asymmetry as intentional. If Telegram ever grows the same
    // caveat it would be false there, and the difference is the finding.
    const tg = stripComments(readSource(TELEGRAM_BOT))
    expect(tg).toMatch(/conciergeEnabled\(\)\s*&&\s*!cmd\.startsWith\("\/"\)/)
  })

  it("the Discord interactions route still handles only slash commands", () => {
    // If this ever stops being true (a gateway worker lands, say), the DM
    // caveat above becomes wrong and should be revisited rather than kept.
    const code = stripComments(readSource(DISCORD_BOT))
    expect(code).toMatch(/APPLICATION_COMMAND/)
    expect(code).not.toMatch(/MESSAGE_CREATE/)
  })

  it("/ask is in the command set that gets registered", () => {
    // The DM line is a dead end if the command itself was never PUT to
    // Discord; the register route's GET reports that gap at runtime.
    const cmds = stripComments(readSource("lib/alerts/discord-commands.ts"))
    expect(cmds).toMatch(/name:\s*"ask"/)
  })
})
