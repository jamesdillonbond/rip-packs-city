// @vitest-environment jsdom
//
// 2026-11-02 — four RTR / Fast Break panels read only `data` / `loading` from useWarmCache, so a FAILED
// read rendered the empty state: "No moments with usable FMV in your wallet yet", "No lineups saved yet",
// the lowest tier at "0 pts", "No game odds available right now". Each now has a failed-read branch.
// Assert the ABSENCE of the false claim, and a no-change control (genuinely empty data still says so).
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

const mode = vi.hoisted(() => ({ value: "error" as "error" | "empty" }))

vi.mock("@/lib/warmup/WarmupContext", () => ({
  useWarmCache: (key: string) => {
    if (mode.value === "error") return { data: undefined, loading: false, error: new Error("503"), refresh: () => {} }
    const empty: Record<string, unknown> = {
      "rtr-picks-today": { picks: [] },
      "rtr-state": { reportedTotalPoints: 0, balanceUsd: 0 },
    }
    const data = key.startsWith("rtr-lock-roi") ? { moments: [] } : key.includes("uses") ? { uses: [] } : (empty[key] ?? {})
    return { data, loading: false, error: null, refresh: () => {} }
  },
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }))

import RTRClient from "@/components/rtr/RTRClient"
import FastBreakClient from "@/components/fast-break/FastBreakClient"

afterEach(cleanup)

const fbProps = { walletAddr: "0xbd94cade097e50ac", runId: "run-1", runName: "Run", lineupSize: 2 as const, hasCaptain: false, gameDate: "2026-11-02" }

describe("RTR + Fast Break: a failed read is not an empty state", () => {
  it("RTR never concludes about the wallet, the tier or the slate from a failed read", () => {
    mode.value = "error"
    const { container } = render(<RTRClient walletAddr="0xbd94cade097e50ac" />)
    const text = container.textContent ?? ""
    expect(text).not.toMatch(/No moments with usable FMV in your wallet/)
    expect(text).not.toMatch(/No game odds available right now/)
    expect(text).not.toMatch(/\b0 pts\b/)
    expect(text).toMatch(/couldn.t be loaded/)
  })

  it("Fast Break never says 'No lineups saved yet' from a failed read", () => {
    mode.value = "error"
    const { container } = render(<FastBreakClient {...(fbProps as any)} />)
    const text = container.textContent ?? ""
    expect(text).not.toMatch(/No lineups saved yet/)
    expect(text).toMatch(/run progress couldn.t be loaded/i)
  })

  it("no-change control: genuinely empty data still renders the honest empty copy", () => {
    mode.value = "empty"
    const rtr = render(<RTRClient walletAddr="0xbd94cade097e50ac" />).container.textContent ?? ""
    expect(rtr).toMatch(/No moments with usable FMV in your wallet/)
    expect(rtr).not.toMatch(/couldn.t be loaded/)
    cleanup()
    const fb = render(<FastBreakClient {...(fbProps as any)} />).container.textContent ?? ""
    expect(fb).toMatch(/No lineups saved yet/)
  })
})
