// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, waitFor, cleanup } from "@testing-library/react"

// /dashboard "Value / 30D": re-pinned 2026-11-22 ~3 PM PT (Trevor: "Show as a stacked chart, so
// users can still visualize the total over time") — moments + sealed packs as STACKED areas on
// one stackId, so the top edge is the total. recharts is stubbed to plain elements that expose
// each area's name and stackId, so the test reads which bands render and that they stack.
vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  const Area = ({ name, stackId }: { name?: string; stackId?: string }) => <div data-testid="line" data-stack={stackId}>{name}</div>
  return { ResponsiveContainer: Pass, AreaChart: Pass, CartesianGrid: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null, Legend: () => null, Area }
})
import ValueHistoryCard, { fmtAxisUsd, fmtDay, nightTotal, packSeriesStart } from "@/components/dashboard/ValueHistoryCard"

const answer = (status: number, body: unknown) =>
  vi.fn(async () => ({ ok: status < 400, status, json: async () => body }) as unknown as Response)

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe("ValueHistoryCard", () => {
  it("formats days by hand (no locale call) and axis dollars", () => {
    expect(fmtDay("2026-11-22")).toBe("Nov 22")
    expect(fmtAxisUsd(25533.7)).toBe("$25.5K")
    expect(fmtAxisUsd(42)).toBe("$42")
  })
  it("a night's total is the sum of the parts it has; no parts -> null, never $0", () => {
    expect(nightTotal({ moments_usd: 49651, packs_usd: 16429.06 })).toBeCloseTo(66080.06, 2)
    expect(nightTotal({ moments_usd: 40100, packs_usd: null })).toBe(40100)
    expect(nightTotal({ moments_usd: null, packs_usd: null })).toBeNull()
  })
  it("names the pack start date only when packs begin inside the window", () => {
    const night = (date: string, packs_usd: number | null) => ({ date, moments_usd: 1, packs_usd, packs_held: null })
    expect(packSeriesStart([night("2026-11-21", null), night("2026-11-22", 5)])).toBe("2026-11-22")
    expect(packSeriesStart([night("2026-11-21", 5), night("2026-11-22", 5)])).toBeNull()
    expect(packSeriesStart([night("2026-11-21", null)])).toBeNull()
  })
  it("stacks the sealed-pack band on the moments band once a snapshot carries a pack value, and says when packs start", async () => {
    vi.stubGlobal("fetch", answer(200, { history: [
      { date: "2026-11-21", moments_usd: 40100, packs_usd: null, packs_held: null },
      { date: "2026-11-22", moments_usd: 40547, packs_usd: 25533.7, packs_held: 327 },
    ] }))
    render(<ValueHistoryCard />)
    await waitFor(() => expect(screen.getAllByTestId("line").map((e) => e.textContent)).toEqual(["Moments", "Sealed packs"]))
    const stacks = screen.getAllByTestId("line").map((e) => e.getAttribute("data-stack"))
    expect(stacks[0]).toBeTruthy()
    expect(stacks[1]).toBe(stacks[0])
    expect(screen.getByText("Sealed packs tracked from Nov 22")).toBeTruthy()
  })
  it("no pack value yet -> moments band only, no start note", async () => {
    vi.stubGlobal("fetch", answer(200, { history: [{ date: "2026-11-21", moments_usd: 40100, packs_usd: null, packs_held: null }] }))
    render(<ValueHistoryCard />)
    await waitFor(() => expect(screen.getAllByTestId("line").map((e) => e.textContent)).toEqual(["Moments"]))
    expect(screen.queryByText(/Sealed packs tracked from/)).toBeNull()
  })
  it("a failed read says so, never an empty chart", async () => {
    vi.stubGlobal("fetch", answer(503, { error: "x" }))
    render(<ValueHistoryCard />)
    await waitFor(() => expect(screen.getByText("Couldn't load your value history just now.")).toBeTruthy())
  })
  it("no snapshots yet", async () => {
    vi.stubGlobal("fetch", answer(200, { history: [] }))
    render(<ValueHistoryCard />)
    await waitFor(() => expect(screen.getByText(/No snapshots yet/)).toBeTruthy())
  })
})
