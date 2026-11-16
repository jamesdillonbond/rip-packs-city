// @vitest-environment jsdom
// The binder's "On Aptos" section (2026-11-16): renders NOTHING for an unlinked collector (never
// "$0" or "none" — Aug–Oct 2025 migrants are not linked until the Dune backfill), one quiet line
// when the read fails, and the valued list when there are moments.
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, waitFor } from "@testing-library/react"
import UfcAptosHoldings from "@/components/collection/UfcAptosHoldings"

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })))
}

const WALLET = "0x8c84d174d73e2d4c"

describe("UfcAptosHoldings", () => {
  it("renders nothing for a collector with no link", async () => {
    stubFetch(200, { linked: false })
    const { container } = render(<UfcAptosHoldings wallet={WALLET} />)
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    expect(container.textContent).toBe("")
  })

  it("a failed read says so, and never shows $0", async () => {
    stubFetch(503, { error: "unavailable" })
    const { findByTestId, container } = render(<UfcAptosHoldings wallet={WALLET} />)
    await findByTestId("ufc-aptos-failed")
    expect(container.textContent).toMatch(/Couldn.t check/)
    expect(container.textContent).not.toMatch(/\$0/)
  })

  it("lists Aptos moments at current FMV, labelled On Aptos", async () => {
    stubFetch(200, {
      linked: true, count: 2, capped: false, priced: 1, unpriced: 1, total_fmv: 3,
      moments: [
        { token_data_id: "0xa", name: null, player_name: "Geoff Neal", set_name: "FN Aug 06 2022", tier: "COMMON", serial_number: 733, circulation_count: 1000, thumbnail_url: null, fmv_usd: 3 },
        { token_data_id: "0xb", name: null, player_name: "Unpriced Guy", set_name: "Set", tier: null, serial_number: 5, circulation_count: null, thumbnail_url: null, fmv_usd: null },
      ],
    })
    const { findByTestId } = render(<UfcAptosHoldings wallet={WALLET} />)
    const sec = await findByTestId("ufc-aptos-holdings")
    expect(sec.textContent).toContain("On Aptos")
    expect(sec.textContent).toContain("$3")
    expect(sec.textContent).toContain("Geoff Neal")
    expect(sec.textContent).toContain("#733/1,000")
    expect(sec.textContent).toContain("1 without a current FMV")
  })

  it("does not call the route for a non-Flow wallet", () => {
    stubFetch(200, { linked: false })
    render(<UfcAptosHoldings wallet="someusername" />)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
