// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

// Top Collector Leaderboard — the SERVER half (components/entity/TopFansSection.tsx, 2026-11-27).
// The client table has its own tests (component-top-fans-table / top-fans-table-client); this pins the
// loader's three-state contract, which only a source scan covered:
//   - a collection with no full holder census is NEVER read (a partial census named the wrong #1) —
//     it comes back pending, sorted after real rankings;
//   - a FAILED read is kept (the table says "couldn't load"), a MEASURED-EMPTY panel is dropped;
//   - every panel measured empty → the section renders nothing.

vi.mock("next/link", () => ({
  default: ({ children, href }: { children?: React.ReactNode; href?: string }) => <a href={typeof href === "string" ? href : "#"}>{children}</a>,
}))

const fetchTopFans = vi.fn()
vi.mock("@/lib/entity/top-fans", async () => {
  const fmt = await vi.importActual<typeof import("@/lib/entity/top-fans-format")>("@/lib/entity/top-fans-format")
  return { ...fmt, fetchTopFans: (...a: unknown[]) => fetchTopFans(...a) }
})

import TopFansSection, { loadTopFansPanels } from "@/components/entity/TopFansSection"
import type { TopFansData } from "@/lib/entity/top-fans-format"

afterEach(() => {
  cleanup()
  fetchTopFans.mockReset()
})

const DATA: TopFansData = {
  refreshed_at: "2026-11-27T20:00:00Z",
  source: "census",
  special_tracked: true,
  holders: 2,
  items: 6,
  rows: [{ owner: "alice", username: "alice", items: 5, special_items: 1, fmv_usd: 900, fmv_items: 5 }],
}
const coll = (urlSlug: string, id: string) => ({ id, urlSlug, displayName: urlSlug, dbSlug: urlSlug.replace(/-/g, "_") }) as never

describe("loadTopFansPanels", () => {
  it("drops measured-empty, keeps failed, never reads a collection without a full census, sorts pending last", async () => {
    fetchTopFans.mockImplementation(async ({ collectionId }: { collectionId: string }) => {
      if (collectionId === "c-candy") return { ok: true, data: { ...DATA, rows: [] } }
      throw new Error("boom")
    })
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const panels = await loadTopFansPanels([
      { collection: coll("nba-top-shot", "c-ts"), kind: "player", key: "p1" },
      { collection: coll("candy-mlb", "c-candy"), kind: "player", key: "p1" },
      { collection: coll("panini-blockchain", "c-panini"), kind: "player", key: "p1", name: "Damian Lillard" },
    ])
    expect(panels.map((p) => [p.collectionId, p.ok, !!p.pending])).toEqual([
      ["c-panini", false, false], // the read threw → kept as failed
      ["c-ts", true, true], // no full census → not read, pending, last
    ])
    expect(fetchTopFans).toHaveBeenCalledTimes(2) // Top Shot was never read
    expect(fetchTopFans.mock.calls.some((c) => (c[0] as { name?: string }).name === "Damian Lillard")).toBe(true)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it("a not-ok answer is kept as failed", async () => {
    fetchTopFans.mockResolvedValue({ ok: false, data: null })
    const panels = await loadTopFansPanels([{ collection: coll("candy-mlb", "c-candy"), kind: "team", key: "t" }])
    expect(panels).toHaveLength(1)
    expect(panels[0]).toMatchObject({ ok: false, data: null, units: "Cards" })
  })
})

describe("TopFansSection", () => {
  it("renders nothing when every panel is measured empty", async () => {
    fetchTopFans.mockResolvedValue({ ok: true, data: { ...DATA, rows: [] } })
    expect(await TopFansSection({ targets: [{ collection: coll("candy-mlb", "c-candy"), kind: "team", key: "t" }], subject: "Blazers" })).toBeNull()
  })

  it("renders the table when a panel has rows", async () => {
    fetchTopFans.mockResolvedValue({ ok: true, data: DATA })
    const out = await TopFansSection({ targets: [{ collection: coll("panini-blockchain", "c-panini"), kind: "team", key: "t" }], subject: "Blazers", title: "Top Fans" })
    render(out!)
    expect(document.body.textContent).toMatch(/Top Fans/)
    expect(document.body.textContent).toMatch(/@alice/)
  })
})
