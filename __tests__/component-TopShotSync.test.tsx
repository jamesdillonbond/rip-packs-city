// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup, waitFor, screen } from "@testing-library/react"

// "Sync from Top Shot": the receiver posts a #topshot-sync= fragment once, clears it, and
// reports a FAILED post as a failure (never "Synced"); the card offers the reader bookmarklet.
const refresh = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))

import { TopShotSyncCard, TopShotSyncReceiver } from "@/components/fast-break/TopShotSync"
import { SYNC_HASH_PREFIX } from "@/lib/fast-break/topshot-sync"

const payload = { contest_id: "contest-run-nba-classic-2026-11-16", today: "2026-11-28", nights: [], players: [] }

function setHash(h: string) {
  window.history.replaceState(null, "", "/nba-top-shot/fast-break" + h)
}

beforeEach(() => {
  refresh.mockReset()
  setHash("")
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("TopShotSyncReceiver", () => {
  it("renders nothing and posts nothing without a sync fragment", () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const { container } = render(<TopShotSyncReceiver />)
    expect(container.textContent).toBe("")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("posts the fragment, clears it, reports the sync and refreshes the page", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ ok: true, walletPinned: true, result: { run: "Classic Run — Nov 16–29", nights_upserted: 13, cards: 116 } }),
    }))
    vi.stubGlobal("fetch", fetchMock)
    setHash(SYNC_HASH_PREFIX + encodeURIComponent(JSON.stringify(payload)))
    render(<TopShotSyncReceiver />)
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Synced Classic Run — Nov 16–29"))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse((fetchMock.mock.calls[0] as any)[1].body)).toEqual(payload)
    expect(window.location.hash).toBe("")
    expect(refresh).toHaveBeenCalled()
  })

  it("reports a failed post as a failure and does not claim a sync", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "ingest_failed" }) })))
    setHash(SYNC_HASH_PREFIX + encodeURIComponent(JSON.stringify(payload)))
    render(<TopShotSyncReceiver />)
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Sync failed (ingest failed)"))
    expect(screen.getByRole("status").textContent).not.toContain("Synced")
    expect(refresh).not.toHaveBeenCalled()
  })

  it("says an unreadable fragment is unreadable instead of posting it", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    setHash(SYNC_HASH_PREFIX + "%7Bnot-json")
    render(<TopShotSyncReceiver />)
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("unreadable"))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("TopShotSyncCard", () => {
  it("offers the reader as a javascript: bookmarklet", () => {
    render(<TopShotSyncCard />)
    const link = screen.getAllByText("Sync from Top Shot").find(el => el.tagName === "A")!
    expect(link.getAttribute("href")?.startsWith("javascript:")).toBe(true)
  })
})
