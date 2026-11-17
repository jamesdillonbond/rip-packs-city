// 2026-10-11 — the concierge must not offer to escalate things RPC cannot have.
//
// RPC sells nothing and has no paid plan (CLAUDE.md: READ-ONLY product; no paid
// tier shown anywhere until 100 WAU). The escalate_to_human prompt + tool used to
// name "NFT missing after a confirmed purchase", "a paying user" and a "billing"
// category, and a real conversation (row 9916, "How can I contact you") answered
// that the bot could escalate "a missing NFT after a purchase or a billing issue".
// That is an offer of an action the product lacks.
//
// Pinned as a PROPERTY of the route source: no escalation text frames an RPC
// purchase, payment or paying user, the category enum carries no billing value,
// and the prompt routes a marketplace purchase problem to that marketplace.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROUTE = readFileSync(join(__dirname, "..", "app", "api", "support-chat", "route.ts"), "utf8")

function escalationTexts(): string[] {
  const promptLine = ROUTE.split("\n").find((l) => l.startsWith("**escalate_to_human**"))
  const toolStart = ROUTE.indexOf('name: "escalate_to_human"')
  const toolBlock = ROUTE.slice(toolStart, ROUTE.indexOf("required:", toolStart))
  if (!promptLine) throw new Error("escalate_to_human prompt line not found — the guard would inspect nothing")
  if (toolStart < 0) throw new Error("escalate_to_human tool not found — the guard would inspect nothing")
  return [promptLine, toolBlock]
}

describe("concierge escalation scope matches a read-only, free product", () => {
  it("never frames an RPC purchase, payment, or paying user as an escalation case", () => {
    for (const text of escalationTexts()) {
      expect(text).not.toMatch(/after a confirmed purchase/i)
      expect(text).not.toMatch(/paying user/i)
      expect(text).not.toMatch(/money lost/i)
    }
  })

  it("carries no billing category", () => {
    const [, tool] = escalationTexts()
    const enumMatch = tool.match(/category:\s*\{[^}]*enum:\s*\[([^\]]*)\]/)
    expect(enumMatch).not.toBeNull()
    expect(enumMatch![1]).not.toMatch(/billing/)
  })

  it("routes a marketplace purchase problem to that marketplace's support", () => {
    const [prompt] = escalationTexts()
    expect(prompt).toMatch(/marketplace's support case/)
    expect(prompt).toMatch(/never offer to escalate a purchase or billing issue/)
  })
})
