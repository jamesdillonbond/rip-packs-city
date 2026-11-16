// The UFC binder's "On Aptos" section fetches /api/ufc/aptos-holdings. The Collection tab is
// anon-public, and proxy.ts 307s any /api/* path NOT in its public-read set to /login — so the
// section would silently never render for a signed-out visitor (shipped that way on 2026-11-16,
// caught by fetching the deployed route). Derived from the component's own fetch, not hand-kept.
import { readFileSync } from "fs"
import { describe, expect, it } from "vitest"

describe("UFC binder backend is anon-public", () => {
  it("every /api path the On Aptos section fetches is listed in proxy.ts's public reads", () => {
    const comp = readFileSync("components/collection/UfcAptosHoldings.tsx", "utf8")
    const proxy = readFileSync("proxy.ts", "utf8")
    const paths = [...comp.matchAll(/fetch\(\s*"(\/api\/[^"?]+)/g)].map((m) => m[1])
    expect(paths.length).toBeGreaterThan(0)
    for (const p of paths) expect(proxy, p).toContain(`"${p}"`)
  })
})
