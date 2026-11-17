import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"
import { isPublicPath } from "@/proxy"

// Every /insights and /analytics page the concierge names in its prompt or tool
// descriptions must (a) exist as an App Router page and (b) be anon-public — a
// link the bot hands out that 404s or bounces to /login is a broken answer the
// user sees as RPC being wrong. Added 2026-10-25 with the /analytics bullet
// (that section became public that day); nothing checked these paths before.

const SRC = readFileSync(join(process.cwd(), "app/api/support-chat/route.ts"), "utf8")

/** Every page route under app/, route groups stripped, dynamic segments kept. */
function pageRoutes(dir = join(process.cwd(), "app"), prefix = ""): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === "api" && prefix === "") continue
      const seg = /^\(.*\)$/.test(name) ? "" : "/" + name
      out.push(...pageRoutes(full, prefix + seg))
    } else if (name === "page.tsx") {
      out.push(prefix || "/")
    }
  }
  return out
}
const ROUTES = pageRoutes()
function routeExists(path: string): boolean {
  const segs = path.split("/").filter(Boolean)
  return ROUTES.some((r) => {
    const rs = r.split("/").filter(Boolean)
    return rs.length === segs.length && rs.every((s, i) => /^\[.+\]$/.test(s) || s === segs[i])
  })
}

// Paths only — stop at characters that cannot be in a slug; drop template
// placeholders (`<wallet>`) and API paths.
const NAMED = Array.from(
  new Set(
    Array.from(SRC.matchAll(/(?<![\w/.-])\/(?:insights|analytics)(?:\/[a-z0-9-]+)*/g), (m) => m[0]),
  ),
).sort()

describe("the concierge hands out only real, public pages", () => {
  it("names a non-trivial set of pages (the extraction is not vacuous)", () => {
    expect(NAMED.length).toBeGreaterThan(25)
    expect(NAMED).toContain("/analytics/api")
    expect(NAMED).toContain("/insights/top-sales")
  })

  it.each(NAMED)("%s exists and is anon-public", (p) => {
    expect(routeExists(p), `${p} is named by the concierge but no page renders it`).toBe(true)
    expect(isPublicPath(p, "GET"), `${p} is named by the concierge but is gated`).toBe(true)
  })

  it("the route matcher rejects a page that does not exist (planted control)", () => {
    expect(routeExists("/insights/no-such-board-xyz")).toBe(false)
    expect(routeExists("/analytics/wallets/0xabc")).toBe(true)
  })
})
