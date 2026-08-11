// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor, act } from "@testing-library/react"

// Control every useWarmCache call by key so we can drive RTRClient's three
// sections (Tonight's Pick / Tier Progress / Lock ROI) through loading, empty,
// and loaded states without a live WarmupProvider or network.
const warmByKey: Record<string, { data: unknown; loading: boolean; error: unknown }> = {}
vi.mock("@/lib/warmup/WarmupContext", () => ({
  useWarmCache: (key: string) => ({
    data: warmByKey[key]?.data ?? null,
    loading: warmByKey[key]?.loading ?? false,
    error: warmByKey[key]?.error ?? null,
    refresh: vi.fn(),
  }),
}))

import RTRClient from "@/components/rtr/RTRClient"

const WALLET = "0xabc"
function setWarm(map: Record<string, { data?: unknown; loading?: boolean; error?: unknown }>) {
  for (const k of Object.keys(warmByKey)) delete warmByKey[k]
  for (const [k, v] of Object.entries(map)) {
    warmByKey[k] = { data: v.data ?? null, loading: v.loading ?? false, error: v.error ?? null }
  }
}

const livePick = {
  gameId: "g1",
  homeTeam: "Lakers",
  awayTeam: "Celtics",
  recommendedSide: "home_ml" as const,
  impliedProbability: 0.62,
  rationale: "Home favorite with rest edge.",
  homeML: -160,
  awayML: 135,
  tipoffAt: "2026-07-26T23:30:00Z",
  bookmaker: "DraftKings",
  oddsLastSyncedAt: "2026-07-26T22:00:00Z",
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe("RTRClient", () => {
  it("shows the loading skeleton for Tonight's Pick while picks load", () => {
    setWarm({ "rtr-picks-today": { loading: true } })
    const { container } = render(<RTRClient walletAddr={WALLET} />)
    expect(container.textContent).toContain("Tonight's Pick")
  })

  it("renders the empty 'no odds' state when there is no pick", () => {
    setWarm({ "rtr-picks-today": { data: { picks: [] } } })
    const { container } = render(<RTRClient walletAddr={WALLET} />)
    expect(container.textContent).toContain("No game odds available right now")
  })

  it("surfaces the no_fresh_odds note when present", () => {
    setWarm({ "rtr-picks-today": { data: { picks: [], message: "no_fresh_odds", note: "Season is over." } } })
    const { container } = render(<RTRClient walletAddr={WALLET} />)
    expect(container.textContent).toContain("Season is over.")
  })

  it("renders the live pick card with the recommended side and de-vigged %", () => {
    setWarm({
      "rtr-picks-today": { data: { picks: [livePick] } },
      "rtr-state": { data: { reportedTotalPoints: 100, reportedSpendableBalance: 50, currentTier: "bronze", reportedAt: null, updatedAt: null } },
      [`rtr-lock-roi:${WALLET}`]: {
        data: {
          walletAddr: WALLET,
          rowCount: 1,
          totalAvailable: 1,
          moments: [
            { momentId: "m1", playerName: "LeBron James", setName: "Base", currentFmvUsd: 42, isLocked: false, estimatedPlayoffPoints: 12, pointsPerDollar: 0.28, serialNumber: 7, tier: "COMMON" },
          ],
        },
      },
    })
    const { container } = render(<RTRClient walletAddr={WALLET} />)
    // recommended side is home_ml → Lakers (CSS uppercases; jsdom textContent stays as-is)
    expect(container.textContent).toContain("Lakers ML")
    expect(container.textContent).toContain("vs Celtics")
    expect(container.textContent).toContain("via DraftKings")
    // the lock-roi moment renders
    expect(container.textContent).toContain("LeBron James")
  })

  describe("lock-ROI top/worst-5 accent (overlap guard)", () => {
    const lockMoment = (i: number) => ({
      momentId: `m${i}`, playerName: `P${i}`, setName: "Base", currentFmvUsd: 42,
      isLocked: false, estimatedPlayoffPoints: 12, pointsPerDollar: 100 - i,
      serialNumber: i + 1, tier: "COMMON",
    })
    // Only lock-roi rows carry `border-left: 3px solid var(--rpc-<color>)`.
    const bordered = (c: HTMLElement, color: string) =>
      Array.from(c.querySelectorAll("tr")).filter((tr) =>
        (tr.getAttribute("style") ?? "").includes(`3px solid var(--rpc-${color})`),
      )

    it("paints NO distinct worst-5 (danger) accent below 10 rows", () => {
      setWarm({ [`rtr-lock-roi:${WALLET}`]: { data: { moments: Array.from({ length: 6 }, (_, i) => lockMoment(i)) } } })
      const { container } = render(<RTRClient walletAddr={WALLET} />)
      expect(bordered(container, "danger").length).toBe(0) // the overlap bug painted 1
      expect(bordered(container, "success").length).toBe(5) // top-5 still accented
    })

    it("paints a distinct worst-5 (danger) accent at >=10 rows", () => {
      setWarm({ [`rtr-lock-roi:${WALLET}`]: { data: { moments: Array.from({ length: 12 }, (_, i) => lockMoment(i)) } } })
      const { container } = render(<RTRClient walletAddr={WALLET} />)
      expect(bordered(container, "danger").length).toBe(5)
      expect(bordered(container, "success").length).toBe(5)
    })
  })
})

// ── LivePickCard "why" toggle + bookmaker/tipoff-absent arms ─────────────────
describe("RTRClient — LivePickCard branches", () => {
  it("toggles the 'why does this matter' explanation open and closed", () => {
    setWarm({ "rtr-picks-today": { data: { picks: [livePick] } } })
    const { container } = render(<RTRClient walletAddr={WALLET} />)
    const btn = [...container.querySelectorAll("button")].find((b) => /why does this matter/i.test(b.textContent ?? ""))!
    expect(btn).toBeTruthy()
    expect(container.textContent).not.toContain("pure +EV with a downside floor")
    fireEvent.click(btn)
    expect(container.textContent).toContain("pure +EV with a downside floor")
    expect(btn.textContent).toMatch(/hide explanation/i)
    fireEvent.click(btn)
    expect(container.textContent).not.toContain("pure +EV with a downside floor")
  })

  it("omits the bookmaker and tipoff labels when the pick carries neither", () => {
    setWarm({ "rtr-picks-today": { data: { picks: [{ ...livePick, bookmaker: null, tipoffAt: null }] } } })
    const { container } = render(<RTRClient walletAddr={WALLET} />)
    expect(container.textContent).toContain("Lakers ML")
    expect(container.textContent).not.toContain("via")
    // tipoff " · <label>" segment only renders when tipoffAt is present
    expect(container.textContent).toContain("vs Celtics")
  })
})

// ── TierProgressSection: loading skeleton + the save flow ────────────────────
describe("RTRClient — Tier Progress save flow", () => {
  const stateData = {
    reportedTotalPoints: 1200,
    reportedSpendableBalance: 300,
    currentTier: "Starter" as const,
    reportedAt: "2026-07-26T00:00:00Z",
    updatedAt: "2026-07-26T00:00:00Z",
  }

  it("renders the loading skeleton while state loads (no data yet)", () => {
    setWarm({ "rtr-state": { loading: true } })
    const { container } = render(<RTRClient walletAddr={WALLET} />)
    expect(container.textContent).toContain("Tier Progress")
    // the number inputs only exist once state has resolved
    expect(container.querySelectorAll('input[type="number"]').length).toBe(0)
  })

  it("rejects negative inputs with an inline error and never POSTs", () => {
    setWarm({ "rtr-state": { data: stateData } })
    const { container } = render(<RTRClient walletAddr={WALLET} />)
    const inputs = container.querySelectorAll('input[type="number"]')
    fireEvent.change(inputs[0], { target: { value: "-5" } })
    fireEvent.change(inputs[1], { target: { value: "-1" } })
    const saveBtn = [...container.querySelectorAll("button")].find((b) => /save/i.test(b.textContent ?? ""))!
    fireEvent.click(saveBtn)
    expect(container.textContent).toContain("Enter non-negative numbers for both fields")
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c: unknown[]) => c[1] != null)).toBe(false)
  })

  it("POSTs valid inputs, clears the fields, and reconciles the warm cache", async () => {
    vi.useFakeTimers()
    try {
      const fresh = { ...stateData, reportedTotalPoints: 5000, reportedSpendableBalance: 250 }
      const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(fresh) })
      vi.stubGlobal("fetch", f)
      setWarm({ "rtr-state": { data: stateData } })
      const { container } = render(<RTRClient walletAddr={WALLET} />)
      const inputs = container.querySelectorAll('input[type="number"]')
      fireEvent.change(inputs[0], { target: { value: "5000" } })
      fireEvent.change(inputs[1], { target: { value: "250" } })
      const saveBtn = [...container.querySelectorAll("button")].find((b) => /save/i.test(b.textContent ?? ""))!
      await act(async () => {
        fireEvent.click(saveBtn)
      })
      const postCall = f.mock.calls.find((c: unknown[]) => (c[1] as { method?: string })?.method === "POST")!
      expect(postCall[0]).toBe("/api/rtr/state")
      const body = JSON.parse((postCall[1] as { body: string }).body)
      expect(body.reportedTotalPoints).toBe(5000)
      expect(body.reportedSpendableBalance).toBe(250)
      // inputs cleared after a successful save
      expect((inputs[0] as HTMLInputElement).value).toBe("")
      // flush the 500ms warm-cache reconcile timer
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("surfaces the server error message when the save POST is not ok", async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({ error: "tier_save_boom" }) })
    vi.stubGlobal("fetch", f)
    setWarm({ "rtr-state": { data: stateData } })
    const { container } = render(<RTRClient walletAddr={WALLET} />)
    const inputs = container.querySelectorAll('input[type="number"]')
    fireEvent.change(inputs[0], { target: { value: "5000" } })
    fireEvent.change(inputs[1], { target: { value: "250" } })
    const saveBtn = [...container.querySelectorAll("button")].find((b) => /save/i.test(b.textContent ?? ""))!
    fireEvent.click(saveBtn)
    await waitFor(() => expect(container.textContent).toContain("tier_save_boom"))
  })
})

// ── LockRoiSection: loading / empty / sort interactions ──────────────────────
describe("RTRClient — Lock ROI states + sort", () => {
  const moment = (o: Record<string, unknown> = {}) => ({
    momentId: "m1", playerName: "LeBron James", setName: "Base", currentFmvUsd: 42,
    isLocked: true, estimatedPlayoffPoints: 12, pointsPerDollar: 0.28, serialNumber: 7, tier: "COMMON", ...o,
  })

  it("renders the loading skeleton while lock-roi loads", () => {
    setWarm({ [`rtr-lock-roi:${WALLET}`]: { loading: true } })
    const { container } = render(<RTRClient walletAddr={WALLET} />)
    expect(container.textContent).toContain("Lock ROI")
    expect(container.querySelector("table")).toBeNull()
    expect(container.textContent).not.toContain("No moments with usable FMV")
  })

  it("shows the empty state when there are zero usable moments", () => {
    setWarm({ [`rtr-lock-roi:${WALLET}`]: { data: { walletAddr: WALLET, rowCount: 0, totalAvailable: 0, moments: [] } } })
    const { container } = render(<RTRClient walletAddr={WALLET} />)
    expect(container.textContent).toContain("No moments with usable FMV in your wallet yet")
  })

  it("clicking a column header sorts and toggles the direction arrow", () => {
    setWarm({
      [`rtr-lock-roi:${WALLET}`]: {
        data: {
          walletAddr: WALLET, rowCount: 2, totalAvailable: 2,
          moments: [moment(), moment({ momentId: "m2", playerName: "Anthony Davis", pointsPerDollar: 0.5 })],
        },
      },
    })
    const { container } = render(<RTRClient walletAddr={WALLET} />)
    const playerTh = [...container.querySelectorAll("th")].find((th) => th.textContent?.startsWith("Player"))!
    // first click: switch to playerName sort (desc) -> ▼ appears on Player
    fireEvent.click(playerTh)
    expect(playerTh.textContent).toContain("▼")
    // second click on the same column toggles to ascending -> ▲
    fireEvent.click(playerTh)
    expect(playerTh.textContent).toContain("▲")
    // both rows still render
    expect(container.textContent).toContain("LeBron James")
    expect(container.textContent).toContain("Anthony Davis")
  })

  it("the mobile sort dropdown drives sortKey + sortDir", () => {
    setWarm({
      [`rtr-lock-roi:${WALLET}`]: {
        data: { walletAddr: WALLET, rowCount: 1, totalAvailable: 1, moments: [moment({ playerName: null, setName: null, serialNumber: null })] },
      },
    })
    const { container } = render(<RTRClient walletAddr={WALLET} />)
    const select = container.querySelector("select") as HTMLSelectElement
    fireEvent.change(select, { target: { value: "currentFmvUsd-asc" } })
    expect(select.value).toBe("currentFmvUsd-asc")
    // null player/set fall back to em dashes rather than blanks
    expect(container.textContent).toContain("—")
  })
})
