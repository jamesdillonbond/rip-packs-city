import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it, expect } from "vitest"
import { COMMANDS } from "@/lib/alerts/discord-commands"

const ROUTE = "app/api/bots/discord/route.ts"
const routeSrc = () => readFileSync(path.join(process.cwd(), ROUTE), "utf8")

/**
 * The interactions route's header region — everything above the first `import`.
 *
 * Scoping to the header is the point: below it, every command name appears in
 * its own `if (name === "…")` handler, so a whole-file search would be
 * satisfied by the handlers and could never see a stale header.
 */
function headerRegion(src: string): string {
  const firstImport = src.search(/^import /m)
  return firstImport === -1 ? src : src.slice(0, firstImport)
}

/**
 * Command names from the header's bullet list, e.g. `//   /ask question:<text>`.
 *
 * What discriminates a list ENTRY from a prose mention is the ANCHOR: the
 * command must open the line, immediately after the comment marker and its
 * indent. That matters because the header discusses `/ask` in prose in the
 * timeout note below the list, and counting prose would defeat the whole guard
 * — the omission of `/ask` survived precisely because the file talked about the
 * command at length while never listing it.
 *
 * ⚠ The `{2,}` indent width is NOT what does that work and must not be
 * described as if it were: it is redundant behind the anchor, and widening it
 * to `\s+` is a mutation this suite cannot kill. It is kept only to match the
 * header's formatting. The anchor is the load-bearing part, so that is what the
 * guards-the-guard case below exercises.
 */
function commandsDocumentedInHeader(src: string): string[] {
  return [...headerRegion(src).matchAll(/^\/\/\s{2,}\/([a-z]+)\b/gm)].map((m) => m[1])
}

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

// ── The route header must document the command set ────────────────────────
//
// This pins DOCS-MATCH-CODE, the shape of
// __tests__/api-fmv-demo-docs-match-implementation.test.ts. It exists because
// the header drifted: it listed /link, /soldpacks and /alerts while COMMANDS
// carried four, so `/ask` — the ONLY concierge path on Discord, since a plain
// DM is a Gateway event this serverless endpoint never receives — was absent
// from the one place a reader looks to find out what the bot does. The same
// header then spent ten lines explaining /ask's 60s->90s maxDuration fix, so it
// contradicted itself rather than merely being incomplete.
//
// ⚠ This asserts ON comments deliberately. Guards elsewhere in this repo strip
// comments first, because they grep source for user-facing COPY and a comment
// quoting that copy is a false positive. Here the comment IS the subject, so
// stripping would leave nothing to check — do not "fix" this by adding a
// stripComments() pass.
describe("discord route header documents the command set", () => {
  it("lists exactly the commands in COMMANDS", () => {
    expect(commandsDocumentedInHeader(routeSrc()).sort()).toEqual(
      COMMANDS.map((c) => c.name).sort()
    )
  })

  it("points at the real registration route, not a helper that does not exist", () => {
    // A command in COMMANDS is invisible to users until it is registered, and
    // that failure reads as a dead bot. The header used to point at a
    // `registerCommands()` in this file, which has never existed, plus a
    // hand-run PUT; the actual entry point is the register route, whose GET
    // reports registered/missing without the bot token leaving the server.
    expect(headerRegion(routeSrc())).toContain("/api/bots/discord/register")
  })

  it("guards the guard: the header parser finds entries and ignores prose", () => {
    // Non-vacuous — a parser that silently matched nothing would let every
    // assertion above pass by comparing two empty sets.
    expect(commandsDocumentedInHeader(routeSrc()).length).toBeGreaterThan(0)

    // A prose mention is NOT a list entry. This is the discrimination the
    // original staleness defeated, so it is asserted directly rather than
    // assumed from the regex. The fixture names three commands in prose and
    // lists only one, so a parser that dropped the anchor would return all
    // four and this would red — which is the mutation that matters.
    const prose = [
      "// Slash commands. The canonical schema is COMMANDS in",
      "// lib/alerts/discord-commands.ts — the note below discusses /ask at",
      "// length, and /soldpacks and /alerts appear only in passing here:",
      "//   /link code:<code>        -> inline reply",
      "",
      "import { NextRequest } from 'next/server'",
    ].join("\n")
    expect(commandsDocumentedInHeader(prose)).toEqual(["link"])
  })

  it("guards the guard: the header region stops at the first import", () => {
    // The handlers below carry `if (name === "ask")` for every command, so a
    // region that ran past the imports would be satisfied by the handlers and
    // could never detect a stale header.
    expect(headerRegion(routeSrc())).not.toContain('name === "ask"')
  })
})
