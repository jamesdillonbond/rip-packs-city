// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { readFileSync } from "node:fs"
import React from "react"

// deep-audit R28. The homepage promised "moment ID" in three places - the
// WalletSearch placeholder, its aria-label, and HOW_STEPS[0] - while the submit
// path had no branch for one. A numeric id fell through to the username
// resolver, missed, and rendered "Couldn't find that username.", with the hint
// directly beneath the input reading "Try a wallet address or username."
// The page contradicted itself in adjacent elements and blamed the reader for
// typing exactly what it asked for.
//
// Fixed by making the promise TRUE (routing to /moment/<id>), not by deleting
// it - app/moment/[id] already exists.

const push = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}))

import WalletSearch from "@/components/WalletSearch"

afterEach(() => { cleanup(); push.mockReset(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function submit(value: string) {
  const input = screen.getByRole("textbox") as HTMLInputElement
  fireEvent.change(input, { target: { value } })
  const form = input.closest("form")
  if (form) fireEvent.submit(form)
  else fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
}

describe("WalletSearch - the moment-ID promise is kept (R28)", () => {
  it("routes a numeric moment id to /moment/<id> without a network call", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    render(<WalletSearch surface="test" />)
    submit("18730957")

    await waitFor(() => expect(push).toHaveBeenCalledWith("/moment/18730957"))
    // Placed before the resolver on purpose: it costs nothing, and an upstream
    // outage cannot break it.
    //
    // NB: assert on the RESOLVER call specifically, not on fetch at all -
    // trackFunnelEvent fires a wallet_paste beacon on every submit by design,
    // so "no fetch happened" would be asserting the wrong thing and would fail
    // for a reason that has nothing to do with R28.
    const resolverCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/wallet-search"))
    expect(resolverCalls).toHaveLength(0)
    // The load-bearing assertion is the ABSENCE of the false accusation.
    expect(screen.queryByText(/Couldn't find that/)).toBeNull()
  })

  it("still routes a Flow address to the wallet view", async () => {
    render(<WalletSearch surface="test" />)
    submit("0x0d744d23165bfb6c")
    await waitFor(() => expect(push).toHaveBeenCalledWith("/share/0x0d744d23165bfb6c"))
  })

  it("does NOT swallow a username that merely starts with a digit", async () => {
    // NO-CHANGE CONTROL. Over-matching would route real usernames to a
    // guaranteed 404 - dishonest in the opposite direction, and invisible
    // without this test.
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ walletAddress: "0x0d744d23165bfb6c" }) }) as any)
    vi.stubGlobal("fetch", fetchMock)
    render(<WalletSearch surface="test" />)
    submit("23jumpstreet")

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const momentPush = push.mock.calls.find((c) => String(c[0]).startsWith("/moment/"))
    expect(momentPush).toBeUndefined()
  })

  it("does not treat a leading-zero string as a moment id", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ walletAddress: null }) }) as any)
    vi.stubGlobal("fetch", fetchMock)
    render(<WalletSearch surface="test" />)
    submit("007")

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(push).not.toHaveBeenCalledWith("/moment/007")
  })
})

describe("R28 - the copy and the behaviour agree", () => {
  it("the surfaces that PROMISE a moment id are backed by a branch that handles one", () => {
    // This is the join the defect actually was. Every behaviour test above would
    // still pass if someone reworded the hint back to "wallet or username" while
    // the branch stayed - or deleted the branch and left the promise standing.
    const search = readFileSync("components/WalletSearch.tsx", "utf8")
    const home = readFileSync("components/HomePageMarketing.tsx", "utf8")

    expect(search).toContain("MOMENT_ID")
    expect(search).toContain("/moment/")

    const promises = (search.match(/moment ID/gi) || []).length + (home.match(/moment ID/gi) || []).length
    expect(promises).toBeGreaterThan(0)

    // The homepage hint must no longer contradict the placeholder.
    expect(home).not.toContain("Try a wallet address or username.")
  })
})
