// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import ProGate from "@/components/ProGate"

// ProGate gates children on RPC Pro status: no wallet → connect-wallet
// message (no fetch); wallet present → fetch /api/pro-status; while
// loading / indeterminate it optimistically renders children; a non-Pro
// result swaps in the upgrade prompt; a Pro result renders children.

let fetchMock: ReturnType<typeof vi.fn>
function okJson(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const CHILD = <div data-testid="gated">SECRET</div>

describe("ProGate", () => {
  it("shows the connect-wallet message and never fetches without a wallet", () => {
    const { container } = render(<ProGate walletAddress={null}>{CHILD}</ProGate>)
    expect(container.textContent).toContain("Connect wallet to access Pro features")
    expect(container.querySelector('[data-testid="gated"]')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("optimistically renders children while the pro-status fetch is in flight", () => {
    fetchMock.mockReturnValue(new Promise(() => {})) // never resolves
    const { container } = render(<ProGate walletAddress="0xabc">{CHILD}</ProGate>)
    expect(container.querySelector('[data-testid="gated"]')).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("swaps in the upgrade prompt for a non-Pro wallet", async () => {
    fetchMock.mockReturnValue(okJson({ isPro: false }))
    const { container } = render(<ProGate walletAddress="0xabc">{CHILD}</ProGate>)
    await waitFor(() => expect(container.textContent).toContain("$9/month"))
    expect(container.textContent).toContain("Upgrade to Pro")
    expect(container.querySelector('[data-testid="gated"]')).toBeNull()
  })

  it("renders children for a Pro wallet", async () => {
    fetchMock.mockReturnValue(okJson({ isPro: true }))
    const { container } = render(<ProGate walletAddress="0xabc">{CHILD}</ProGate>)
    await waitFor(() => expect(container.querySelector('[data-testid="gated"]')).not.toBeNull())
    expect(container.textContent).not.toContain("$9/month")
  })
})
