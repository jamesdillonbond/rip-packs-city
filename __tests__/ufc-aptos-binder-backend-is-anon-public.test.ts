// The UFC binder's Aptos rows come from /api/ufc/aptos-holdings (since 2026-11-26 fetched by
// CollectionTabClient itself — the separate "On Aptos" panel was folded into the one table). The Collection tab is
// anon-public, and proxy.ts 307s any /api/* path NOT in its public-read set to /login — so the
// section would silently never render for a signed-out visitor (shipped that way on 2026-11-16,
// caught by fetching the deployed route). Derived from the component's own fetch, not hand-kept.
import { readFileSync } from "fs"
import { describe, expect, it } from "vitest"

describe("UFC binder backend is anon-public", () => {
  it("every /api/ufc path the binder fetches is listed in proxy.ts's public reads", () => {
    const comp = readFileSync("app/(collections)/[collection]/collection/CollectionTabClient.tsx", "utf8")
    const proxy = readFileSync("proxy.ts", "utf8")
    const paths = [...comp.matchAll(/fetch\(\s*"(\/api\/ufc\/[^"?]+)/g)].map((m) => m[1])
    expect(paths.length).toBeGreaterThan(0)
    for (const p of paths) expect(proxy, p).toContain(`"${p}"`)
  })
})
