// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"
import TeamChecklist from "@/components/entity/TeamChecklist"

// Reader filters (webz, 2026-10-01): a tier chip toggles that tier out of the
// checklist — tiles AND header — and is remembered per collection; with a
// wallet, the owned+locked / owned / missing legend toggles those tiles. Any
// filter reads the COMPLETE list (?view=all in "All moments") — a header
// re-totalled from the 24-row page would be false.

vi.mock("next/link", () => ({ default: ({ children, ...p }: { children?: React.ReactNode } & Record<string, unknown>) => <a {...p}>{children}</a> }))

const res = (ok: boolean, body: unknown) =>
  Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) } as Response)

const W = "0x0123456789abcdef"
const byTier = [
  { tier: "ULTIMATE", total: 1, owned: 0, cost_usd: 3000 },
  { tier: "COMMON", total: 2, owned: 1, cost_usd: 5 },
]
const rpcProgress = { total: 3, owned: 1, locked_owned: 1, missing_count: 2, completion_pct: 33.3, cost_to_complete_usd: 3005, stale_missing_pct: null, wallet_cached: true, scope: "all_time", by_tier: byTier }
const t = (route_slug: string, player_name: string, tier: string, cost: number, owned: boolean, locked = false) =>
  ({ route_slug, player_name, tier, fmv_usd: cost, floor_usd: cost, thumbnail_url: null, owned, owned_locked: locked, edition_cost_usd: cost })
const complete = {
  has_parallels: false,
  progress: { ...rpcProgress, unpriced_missing_count: 0 },
  editions: [t("1:1", "Ultimate Guy", "ULTIMATE", 3000, false), t("1:2", "Missing Guy", "COMMON", 5, false), t("1:3", "Owned Guy", "COMMON", 7, true, true)],
}

function routeFetch() {
  return vi.fn((url: string) => {
    if (url.includes("/api/profile/me")) return res(true, { user: null })
    if (url.includes("team-checklist-full-editions") && url.includes("probe=1")) return res(true, { has_parallels: false })
    if (url.includes("team-checklist-full-editions")) return res(true, complete)
    if (url.includes("team-checklist-progress")) return res(true, rpcProgress)
    return res(true, complete.editions.map((e) => ({ ...e, edition_cost_usd: undefined })))
  })
}

beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem("rpc_checklist_wallet", W)
  window.history.replaceState(null, "", "/nba-top-shot/team/detroit-pistons")
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("TeamChecklist reader filters", () => {
  it("hiding a tier drops it from the tiles AND re-totals owned / % / cost over the complete list", async () => {
    const f = routeFetch()
    vi.stubGlobal("fetch", f)
    const { getByText, getByRole, queryByText, findByText } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="detroit-pistons" />)
    await findByText("1 / 3")
    expect(getByText("Ultimate Guy")).toBeTruthy()
    expect(queryByText(/\$3,005/)).toBeTruthy()
    fireEvent.click(getByRole("button", { name: /ULTIMATE/ }))
    await waitFor(() => expect(getByText("1 / 2")).toBeTruthy())
    // Cost-to-complete no longer carries the $3,000 Ultimate.
    expect(queryByText(/\$3,005/)).toBeNull()
    expect(queryByText("Ultimate Guy")).toBeNull()
    expect(getByText(/Excluding Ultimate from the totals/)).toBeTruthy()
    // The filtered header came from the complete, ungrouped list — not the page.
    expect(f.mock.calls.some((c) => String(c[0]).includes("team-checklist-full-editions") && String(c[0]).includes("view=all"))).toBe(true)
    // The hidden chip stays on screen so it can be turned back on, and is remembered.
    expect(getByRole("button", { name: /ULTIMATE/ }).getAttribute("aria-pressed")).toBe("false")
    expect(JSON.parse(window.localStorage.getItem("rpc:team-checklist:hidden-tiers:nba-top-shot")!)).toEqual(["ULTIMATE"])
    fireEvent.click(getByText("Show all tiers"))
    await waitFor(() => expect(getByText("1 / 3")).toBeTruthy())
    expect(window.localStorage.getItem("rpc:team-checklist:hidden-tiers:nba-top-shot")).toBeNull()
  })

  it("a remembered hidden tier applies on load", async () => {
    window.localStorage.setItem("rpc:team-checklist:hidden-tiers:nba-top-shot", JSON.stringify(["ULTIMATE"]))
    vi.stubGlobal("fetch", routeFetch())
    const { findByText, queryByText } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="detroit-pistons" />)
    await findByText("1 / 2")
    expect(queryByText("Ultimate Guy")).toBeNull()
  })

  it("the legend toggles: showing only Missing hides owned tiles but leaves the header alone", async () => {
    vi.stubGlobal("fetch", routeFetch())
    const { getByText, queryByText, findByText } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="detroit-pistons" />)
    await findByText("Owned Guy")
    fireEvent.click(getByText("Owned + locked"))
    fireEvent.click(getByText("Owned"))
    await waitFor(() => expect(queryByText("Owned Guy")).toBeNull())
    expect(getByText("Missing Guy")).toBeTruthy()
    expect(getByText("Ultimate Guy")).toBeTruthy()
    expect(getByText("1 / 3")).toBeTruthy()
    // Nothing left on: say so, never "No editions for this scope".
    fireEvent.click(getByText("Missing"))
    await waitFor(() => expect(getByText(/Nothing matches these filters/)).toBeTruthy())
    expect(queryByText(/No editions for this scope/)).toBeNull()
  })

  it("without a wallet there is no ownership filter, but tiers still toggle", async () => {
    window.localStorage.removeItem("rpc_checklist_wallet")
    vi.stubGlobal("fetch", routeFetch())
    const { getByText, getByRole, queryByText, findByText } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="detroit-pistons" />)
    await findByText("3 editions")
    expect(queryByText("Missing")).toBeNull()
    fireEvent.click(getByRole("button", { name: /ULTIMATE/ }))
    await waitFor(() => expect(getByText("2 editions")).toBeTruthy())
  })
})
