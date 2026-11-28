// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

// Top Collector Leaderboard — the SERVER half (components/entity/TopFansSection.tsx, 2026-11-27).
// The client table has its own tests (component-top-fans-table / top-fans-table-client); this pins the
// loader's three-state contract, which only a source scan covered:
//   - a read whose reader says census_complete=false (or, without the flag, a collection outside the static
//     full-census set) comes back PENDING with its rows dropped server-side — a partial census named the
//     wrong #1 (11-27) — sorted after real rankings; re-pinned 11-27 evening when the flag moved into the
//     reader (it used to skip the read outright);
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
  it("drops measured-empty, keeps failed, never passes on a ranking without a full census, sorts pending last", async () => {
    fetchTopFans.mockImplementation(async ({ collectionId }: { collectionId: string }) => {
      if (collectionId === "c-candy") return { ok: true, data: { ...DATA, rows: [] } }
      if (collectionId === "c-ts") return { ok: true, data: { ...DATA, census_complete: false } }
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
      ["c-ts", true, true], // not a full census → pending, last
    ])
    // The partial Top Shot rows never leave the server.
    expect(panels.find((p) => p.collectionId === "c-ts")?.data).toBeNull()
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

describe("loadTopFansPanels — the reader's census flag decides", () => {
  it("census_complete=true ranks Top Shot; no flag falls back to the static set", async () => {
    fetchTopFans.mockImplementation(async ({ collectionId }: { collectionId: string }) =>
      collectionId === "c-ts" ? { ok: true, data: { ...DATA, census_complete: true } } : { ok: true, data: DATA })
    const panels = await loadTopFansPanels([
      { collection: coll("nba-top-shot", "c-ts"), kind: "team", key: "t" },
      { collection: coll("nfl-all-day", "c-ad"), kind: "team", key: "t" },
      { collection: coll("panini-blockchain", "c-panini"), kind: "team", key: "t" },
    ])
    expect(panels.map((p) => [p.collectionId, !!p.pending, p.data?.rows.length ?? null])).toEqual([
      ["c-ts", false, 1],
      ["c-panini", false, 1],
      ["c-ad", true, null],
    ])
  })
})
