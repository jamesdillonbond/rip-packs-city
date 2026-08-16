// @vitest-environment jsdom
import type React from "react"
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react"
import SpecialSerialOwnersClient from "@/app/special-serial-owners/SpecialSerialOwnersClient"

// Second page in this sweep with the same shape: a summary band rendered ABOVE a section
// whose own failure ladder was already correct, so the page contradicted itself — the KPIs
// said "0 special serials / 0 distinct holders" while the list said "Failed to load".
//
// Found by converting the page, not by reading it: a `page.tsx` is measured by neither
// coverage gate, so nothing could drive its failure path until the body moved to a
// *Client.tsx that the component gate includes.

// ⚠ Typed as a real object, not `never`: a rest element cannot be created from `never`
// (TS2700), so the tidy-looking `...p` spread type-checks in vitest and reds `tsc` — the
// repo's most-repeated CI breakage, met here for the third time in one session.
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children?: React.ReactNode } & Record<string, unknown>) => (
    <a {...rest}>{children}</a>
  ),
}))
vi.mock("@/components/MobileNav", () => ({ default: () => null }))
// ⚠ MobileNav pulls in SupportChatConnected, which reads `usePathname()` and calls
// `.split` on it unguarded — so in jsdom, where the App Router provides no path, the whole
// tree throws before a single assertion runs. Stubbed at the router rather than by mocking
// another component, because the same null would bite any future page test that mounts it.
vi.mock("next/navigation", () => ({
  usePathname: () => "/special-serial-owners",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

const ROW = {
  holder_address: "0xabc",
  holder_username: "collector",
  edition_key: "48:1652",
  player_name: "Damian Lillard",
  set_name: "Archive Set",
  tier: "LEGENDARY",
  serial_number: 1,
  circulation_count: 1000,
  edition_fmv: 4200,
  tag: "first_mint",
  last_seen: new Date().toISOString(),
}

const okFetch = (rows: unknown[]) =>
  vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ rows }) }) as unknown as Response)

afterEach(() => cleanup())

describe("SpecialSerialOwnersClient — a failed read must not publish a summary", () => {
  it("withholds every KPI when the read fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response))
    render(<SpecialSerialOwnersClient />)

    await waitFor(() => expect(screen.getByText(/Failed to load/i)).toBeTruthy())

    // ⚠ Assert the ABSENCE of the false claim, not the presence of the error message. The
    // error message was ALREADY there, one section below, the whole time.
    const values = Array.from(document.querySelectorAll(".rpc-sso-kpi-value")).map((n) => n.textContent)
    expect(values).toEqual(["—", "—", "—"])
    expect(values).not.toContain("0")
  })

  it("publishes the KPIs on a successful read", async () => {
    vi.stubGlobal("fetch", okFetch([ROW, { ...ROW, holder_address: "0xdef", serial_number: 7 }]))
    render(<SpecialSerialOwnersClient />)

    await waitFor(() => {
      const v = Array.from(document.querySelectorAll(".rpc-sso-kpi-value")).map((n) => n.textContent)
      if (v[0] !== "2") throw new Error("not loaded")
    })
    const values = Array.from(document.querySelectorAll(".rpc-sso-kpi-value")).map((n) => n.textContent)
    expect(values[0]).toBe("2")      // two special serials
    expect(values[1]).toBe("2")      // two distinct holders
    expect(values[2]).toMatch(/4,?200/) // top edition FMV
    expect(screen.queryByText(/Failed to load/i)).toBeNull()
  })

  // ⚠ BOTH DIRECTIONS. A genuinely empty result is an honest answer and must still read as
  // zero — blanking every empty state only moves the dishonesty.
  it("still shows a real zero when the read SUCCEEDED with no rows", async () => {
    vi.stubGlobal("fetch", okFetch([]))
    render(<SpecialSerialOwnersClient />)

    await waitFor(() => expect(screen.getByText(/No special serials match those filters/i)).toBeTruthy())
    const values = Array.from(document.querySelectorAll(".rpc-sso-kpi-value")).map((n) => n.textContent)
    expect(values[0]).toBe("0")
    expect(values[1]).toBe("0")
  })

  // ⚠ THE GUARD IS ON `error`, NOT ON `rows.length`, and this is why: a refresh failure
  // KEEPS the previous rows, so a value-based guard would publish stale figures as current
  // while the list below said the read had failed.
  it("withholds the KPIs on a REFRESH failure even though rows are still in state", async () => {
    // ⚠ A `mockResolvedValueOnce` chain is the wrong tool here: the mount effect can fire
    // more than once, so "the first call succeeds" is not the same as "the first RENDER
    // succeeds" — the failing response gets consumed by an invocation the test never
    // intended and the setup looks broken rather than the assertion failing honestly.
    // A mutable flag makes the transition explicit and order-independent.
    let fail = false
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fail
          ? ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response)
          : ({ ok: true, status: 200, json: async () => ({ rows: [ROW] }) } as unknown as Response),
      ),
    )

    render(<SpecialSerialOwnersClient />)
    await waitFor(() => {
      const v = document.querySelector(".rpc-sso-kpi-value")?.textContent
      if (v !== "1") throw new Error("not loaded")
    })

    fail = true
    // Change a filter to trigger the refetch through the page's own control.
    fireEvent.click(screen.getByRole("tab", { name: /jersey/i }))
    await waitFor(() => expect(screen.getByText(/Failed to load/i)).toBeTruthy())

    // The rows are STILL in state — a guard on `rows.length` would publish them as current.
    const values = Array.from(document.querySelectorAll(".rpc-sso-kpi-value")).map((n) => n.textContent)
    expect(values).toEqual(["—", "—", "—"])
  })
})

describe("SpecialSerialOwnersClient — the filters reach the request", () => {
  function lastUrl(f: ReturnType<typeof vi.fn>): string {
    const c = f.mock.calls
    return String(c[c.length - 1]?.[0] ?? "")
  }

  it("sends collection, tag, tier and sort, omitting the 'all' defaults", async () => {
    const f = okFetch([ROW])
    vi.stubGlobal("fetch", f)
    render(<SpecialSerialOwnersClient />)
    await waitFor(() => expect(lastUrl(f)).toMatch(/collection=/))

    // The defaults are omitted rather than sent as "all": a filter that is not set must not
    // appear in the query at all, or the API has to special-case a sentinel value.
    expect(lastUrl(f)).not.toMatch(/tag=all/)
    expect(lastUrl(f)).not.toMatch(/tier=all/)
    expect(lastUrl(f)).toMatch(/sort=fmv/)

    fireEvent.click(screen.getByRole("tab", { name: /jersey/i }))
    await waitFor(() => expect(lastUrl(f)).toMatch(/tag=/))
  })

  it("changing the sort re-requests with the new key", async () => {
    const f = okFetch([ROW])
    vi.stubGlobal("fetch", f)
    render(<SpecialSerialOwnersClient />)
    await waitFor(() => expect(lastUrl(f)).toMatch(/sort=fmv/))

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "recent" } })
    await waitFor(() => expect(lastUrl(f)).toMatch(/sort=recent/))
  })

  // ⚠ The player search is DEBOUNCED. Asserting on the request immediately after typing
  // would pass or fail on timing rather than on behaviour, so this drives the debounce out
  // with waitFor rather than a fixed sleep.
  it("debounces the player search before it reaches the request", async () => {
    const f = okFetch([ROW])
    vi.stubGlobal("fetch", f)
    render(<SpecialSerialOwnersClient />)
    await waitFor(() => expect(lastUrl(f)).toMatch(/collection=/))

    fireEvent.change(screen.getByPlaceholderText(/search player/i), { target: { value: "lillard" } })
    expect(lastUrl(f)).not.toMatch(/player=lillard/)
    await waitFor(() => expect(lastUrl(f)).toMatch(/player=lillard/), { timeout: 2000 })
  })
})
