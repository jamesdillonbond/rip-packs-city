// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, fireEvent, within } from "@testing-library/react"

// components/entity/TopFansTable.tsx (Top Fans, 2026-11-27). It shipped without a
// render test, which put the component coverage gate under its threshold. Pinned:
//   · the three per-panel states stay apart — FAILED says "couldn't load", a
//     measured-empty panel says no collector holds it, rows render a table;
//   · the rank-by chips re-rank (FMV default → count → special serials), and
//     "Special serials" is disabled where serials aren't tracked;
//   · collection chips switch panels on a hub; a fan with no username shows a
//     shortened wallet, and a partly priced FMV carries "*".

import TopFansTable from "@/components/entity/TopFansTable"
import type { TopFansPanel } from "@/lib/entity/top-fans-format"

afterEach(cleanup)

const TS: TopFansPanel = {
  collectionId: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  urlSlug: "nba-top-shot",
  label: "NBA Top Shot",
  units: "Moments",
  ok: true,
  data: {
    refreshed_at: "2026-11-27T20:00:00Z",
    source: "wmc",
    special_tracked: true,
    holders: 42,
    items: 900,
    rows: [
      { owner: "0xaaaaaaaaaaaaaaa1", username: "bigfmv", items: 5, special_items: 0, fmv_usd: 5000, fmv_items: 5 },
      { owner: "0xbbbbbbbbbbbbbbb2", username: "manycount", items: 80, special_items: 1, fmv_usd: 900, fmv_items: 70 },
      { owner: "0x7e1a7dbe10882e17", username: null, items: 12, special_items: 4, fmv_usd: 300, fmv_items: 12 },
    ],
  },
}

const PIN: TopFansPanel = {
  collectionId: "7dd9dd11-e8b6-45c4-ac99-71331f959714",
  urlSlug: "disney-pinnacle",
  label: "Disney Pinnacle",
  units: "Pins",
  ok: true,
  data: { refreshed_at: "2026-11-27T20:00:00Z", source: "chain", special_tracked: false, holders: null, items: 3, rows: [
    { owner: "0xccccccccccccccc3", username: "pinfan", items: 3, special_items: null, fmv_usd: 120, fmv_items: 3 },
  ] },
}

const names = (c: HTMLElement) => Array.from(c.querySelectorAll("a")).map((a) => a.textContent ?? "")

describe("TopFansTable", () => {
  it("renders nothing with no panels", () => {
    const { container } = render(<TopFansTable panels={[]} subject="Cooper Flagg" />)
    expect(container.textContent).toBe("")
  })

  it("ranks by FMV by default, then re-ranks by count and by special serials", () => {
    const { container, getByRole } = render(<TopFansTable panels={[TS]} subject="Cooper Flagg" />)
    expect(names(container)[0]).toContain("@bigfmv")
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "")
    expect(hrefs.some((h) => h.includes("/nba-top-shot/collection") && h.includes("0xaaaaaaaaaaaaaaa1"))).toBe(true)
    fireEvent.click(getByRole("button", { name: "Moments" }))
    expect(names(container)[0]).toContain("@manycount")
    fireEvent.click(getByRole("button", { name: "Special serials" }))
    expect(names(container)[0]).not.toContain("@")
    // A fan with no username is a shortened wallet, never the full key.
    expect(names(container)[0]).not.toContain("0x7e1a7dbe10882e17")
    // Partly priced FMV is marked; the footer names the population.
    expect(container.textContent).toMatch(/\$900[.0-9]*\*/)
    expect(container.textContent).toContain("42 collectors seen holding 900 moments")
  })

  it("a FAILED panel says it couldn't load and shows no table", () => {
    const { container } = render(<TopFansTable panels={[{ ...TS, ok: false, data: null }]} subject="Cooper Flagg" />)
    expect(container.textContent).toMatch(/Couldn.t load the NBA Top Shot leaderboard/)
    expect(container.querySelectorAll("a").length).toBe(0)
  })

  it("a measured-empty special-serial ranking says nobody holds one", () => {
    const noSpecial: TopFansPanel = { ...TS, data: { ...TS.data!, rows: TS.data!.rows.map((r) => ({ ...r, special_items: 0 })) } }
    const { container, getByRole } = render(<TopFansTable panels={[noSpecial]} subject="Cooper Flagg" />)
    fireEvent.click(getByRole("button", { name: "Special serials" }))
    expect(container.textContent).toContain("No collector RPC can see holds a special serial of Cooper Flagg on NBA Top Shot.")
  })

  it("on a hub, collection chips switch panels; untracked serials disable that ranking", () => {
    const { container, getByRole } = render(<TopFansTable panels={[TS, PIN]} subject="Portland" />)
    const group = getByRole("group", { name: "Collection" })
    fireEvent.click(within(group).getByRole("button", { name: "Disney Pinnacle" }))
    expect(names(container)[0]).toContain("@pinfan")
    const special = getByRole("button", { name: "Special serials" }) as HTMLButtonElement
    expect(special.disabled).toBe(true)
    expect(getByRole("button", { name: "Pins" })).toBeTruthy()
    expect(container.textContent).not.toContain("Special serials are #1")
  })
})
