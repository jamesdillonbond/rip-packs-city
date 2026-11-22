// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, waitFor, cleanup } from "@testing-library/react"

// /dashboard "Value / 30D" (2026-11-22): moments + sealed packs as two lines. recharts is
// stubbed to plain elements that expose the line names, so the test reads which lines render.
vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  const Line = ({ name }: { name?: string }) => <div data-testid="line">{name}</div>
  return { ResponsiveContainer: Pass, LineChart: Pass, CartesianGrid: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null, Legend: () => null, Line }
})
import ValueHistoryCard, { fmtAxisUsd, fmtDay } from "@/components/dashboard/ValueHistoryCard"

const answer = (status: number, body: unknown) =>
  vi.fn(async () => ({ ok: status < 400, status, json: async () => body }) as unknown as Response)

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe("ValueHistoryCard", () => {
  it("formats days by hand (no locale call) and axis dollars", () => {
    expect(fmtDay("2026-11-22")).toBe("Nov 22")
    expect(fmtAxisUsd(25533.7)).toBe("$25.5K")
    expect(fmtAxisUsd(42)).toBe("$42")
  })
  it("draws the sealed-pack line only once a snapshot carries a pack value", async () => {
    vi.stubGlobal("fetch", answer(200, { history: [
      { date: "2026-11-21", moments_usd: 40100, packs_usd: null, packs_held: null },
      { date: "2026-11-22", moments_usd: 40547, packs_usd: 25533.7, packs_held: 327 },
    ] }))
    render(<ValueHistoryCard />)
    await waitFor(() => expect(screen.getAllByTestId("line").map((e) => e.textContent)).toEqual(["Moments (FMV, incl. stale-priced)", "Sealed packs (low ask)"]))
  })
  it("no pack value yet -> moments line only", async () => {
    vi.stubGlobal("fetch", answer(200, { history: [{ date: "2026-11-21", moments_usd: 40100, packs_usd: null, packs_held: null }] }))
    render(<ValueHistoryCard />)
    await waitFor(() => expect(screen.getAllByTestId("line").map((e) => e.textContent)).toEqual(["Moments (FMV, incl. stale-priced)"]))
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
