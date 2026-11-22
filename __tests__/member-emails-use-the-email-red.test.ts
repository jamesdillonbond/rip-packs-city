import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

// Member-facing email HTML uses the EMAIL red #E55A4C, hardcoded on purpose (mail clients have no
// CSS custom properties; docs/reference/brand-auth-proxy.md). The WEB red #E03A2F slipped into the
// weekly portfolio email (logo + CTA) and the legacy digest (2026-11-22). The inverse guard —
// the email red on WEB surfaces — is scripts/check-brand-tokens.mjs.
// Scope: every file under lib/emails/ (a tree walk, not a list) plus the two digest senders.

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []
  })
}

const FILES = [...walk("lib/emails"), "app/api/cron/weekly-digest/route.ts", "app/api/send-digest/route.ts"]

describe("member emails use the email red, never the web red", () => {
  it("inspects a non-trivial population", () => {
    expect(FILES.length).toBeGreaterThan(5)
  })
  it.each(FILES)("%s carries no #E03A2F", (f) => {
    expect(readFileSync(f, "utf8")).not.toMatch(/#E03A2F/i)
  })
})
