import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// A client-side <Link> keeps the CURRENT document's Content-Security-Policy.
// proxy.ts gives /admin/giveaways the only policy that frames Flow's wallet
// picker; reached from /admin by <Link>, Chrome refused to frame
// fcl-discovery.onflow.org under /admin's policy (2026-09-29). The admin index
// must open it with a full page load.
describe("admin index opens the giveaway console with a full page load", () => {
  const src = readFileSync(join(process.cwd(), "app/admin/page.tsx"), "utf8")

  it("marks the /admin/giveaways tool fullLoad", () => {
    const entry = src.match(/\{\s*href: "\/admin\/giveaways",[\s\S]*?\n {2}\}/)
    expect(entry, "the /admin/giveaways tool entry").not.toBeNull()
    expect(entry![0]).toMatch(/fullLoad: true/)
  })

  it("renders a fullLoad tool as a plain anchor, not a Link", () => {
    expect(src).toMatch(/tool\.fullLoad \? \(\s*<a key=\{tool\.href\} href=\{tool\.href\}/)
  })
})
