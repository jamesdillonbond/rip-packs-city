// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import UfcMomentChain from "@/components/entity/UfcMomentChain"

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const stub = (r: { ok: boolean; body?: unknown }) =>
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: r.ok, json: async () => r.body })))
const ED = "e0000000-0000-0000-0000-000000000001"

describe("UfcMomentChain", () => {
  it("an Aptos Moment says so, tagged Aptos, with Rarible and explorer links", async () => {
    stub({ ok: true, body: { chain: "aptos", rarible_url: "https://rarible.com/collection/aptos/0xabc/items", explorer_url: "https://explorer.aptoslabs.com/token/0xt?network=mainnet", held_by_ufc: "UFC Strike store" } })
    const { findByTestId, container } = render(<UfcMomentChain editionId={ED} serial={7} />)
    const box = await findByTestId("ufc-moment-chain")
    expect(box.textContent).toContain("lives on Aptos, held by UFC Strike store")
    expect(container.querySelector('[data-testid="chain-tag"]')?.textContent).toBe("Aptos")
    expect([...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toContain("https://rarible.com/collection/aptos/0xabc/items")
  })

  it("a Flow Moment is tagged Flow", async () => {
    stub({ ok: true, body: { chain: "flow" } })
    const { findByTestId } = render(<UfcMomentChain editionId={ED} serial={7} />)
    expect((await findByTestId("ufc-moment-chain")).textContent).toContain("lives on Flow")
  })

  it("a failed or unknown check renders nothing — never a guessed chain", async () => {
    for (const r of [{ ok: false }, { ok: true, body: { chain: null } }]) {
      stub(r)
      const { container } = render(<UfcMomentChain editionId={ED} serial={7} />)
      await waitFor(() => expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1))
      await new Promise((res) => setTimeout(res, 0))
      expect(container.textContent).toBe("")
      cleanup()
      vi.unstubAllGlobals()
    }
  })
})
