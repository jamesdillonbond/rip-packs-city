// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import MarketplaceUnavailablePill from "@/components/marketplace-status/MarketplaceUnavailablePill"
import FlowtyDormancyChip from "@/components/marketplace-status/FlowtyDormancyChip"
import MarketplaceStatusBanner from "@/components/marketplace-status/MarketplaceStatusBanner"
import type { MarketplaceStatus } from "@/lib/marketplace-status"

// Covers the marketplace-status component subtree — the per-collection banner /
// dormancy chip / unavailable-buy-CTA pill that tell a collector why a buy button
// is greyed out or a venue looks thin. The pill is pure props; the chip + banner
// read the shared useMarketplaceStatus hook (module-cached fetch), so each case
// uses a DISTINCT slug to avoid the memoryCache bleeding across tests.

let fetchMock: ReturnType<typeof vi.fn>
const okJson = (b: unknown) =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(b) } as Response)

function status(over: Partial<MarketplaceStatus>): MarketplaceStatus {
  return {
    collectionId: "c",
    slug: over.slug ?? "s",
    status: "healthy",
    buyCtasEnabled: true,
    primaryVenue: null,
    primaryContract: null,
    secondaryVenue: null,
    secondaryStatus: null,
    packSecondaryVenue: null,
    lastVerifiedAt: null,
    notes: null,
    ...over,
  }
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

describe("MarketplaceUnavailablePill", () => {
  it("renders the default label and a fallback tooltip when no notes", () => {
    const { getByRole } = render(<MarketplaceUnavailablePill />)
    const el = getByRole("button")
    expect(el.textContent).toBe("MARKETPLACE UNAVAILABLE")
    expect(el.getAttribute("aria-disabled")).toBe("true")
    expect(el.getAttribute("title")).toMatch(/unavailable/i)
  })

  it("uses the notes as the tooltip (trimmed) and a custom label", () => {
    const { getByRole } = render(
      <MarketplaceUnavailablePill notes="  UFC migrated to Aptos  " label="SUNSET" />,
    )
    const el = getByRole("button")
    expect(el.textContent).toBe("SUNSET")
    expect(el.getAttribute("title")).toBe("UFC migrated to Aptos")
  })
})

describe("FlowtyDormancyChip", () => {
  it("renders the offline note only when healthy AND secondary is dormant", async () => {
    fetchMock.mockReturnValueOnce(
      okJson(status({ slug: "chip-a", status: "healthy", secondaryStatus: "dormant_since_may" })),
    )
    const { findByRole } = render(<FlowtyDormancyChip collectionSlug="chip-a" />)
    const note = await findByRole("note")
    expect(note.textContent).toMatch(/currently offline/i)
  })

  it("renders nothing when the collection is not healthy", async () => {
    fetchMock.mockReturnValueOnce(
      okJson(status({ slug: "chip-b", status: "shutdown", secondaryStatus: "dormant_x" })),
    )
    const { container } = render(<FlowtyDormancyChip collectionSlug="chip-b" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.querySelector('[role="note"]')).toBeNull()
  })

  it("renders nothing when secondary is not dormant", async () => {
    fetchMock.mockReturnValueOnce(
      okJson(status({ slug: "chip-c", status: "healthy", secondaryStatus: "live" })),
    )
    const { container } = render(<FlowtyDormancyChip collectionSlug="chip-c" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.querySelector('[role="note"]')).toBeNull()
  })
})

describe("MarketplaceStatusBanner", () => {
  it("renders shutdown copy for a shutdown collection", async () => {
    fetchMock.mockReturnValueOnce(
      okJson(status({ slug: "ufc", status: "shutdown", notes: "Migrated to Aptos" })),
    )
    const { findByRole } = render(<MarketplaceStatusBanner collectionSlug="ufc" />)
    const banner = await findByRole("status")
    expect(banner.textContent).toBeTruthy()
    expect(banner.getAttribute("aria-live")).toBe("polite")
  })

  it("renders nothing for a healthy collection", async () => {
    fetchMock.mockReturnValueOnce(okJson(status({ slug: "banner-healthy", status: "healthy" })))
    const { container } = render(<MarketplaceStatusBanner collectionSlug="banner-healthy" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it("renders nothing (no crash) when the status fetch fails", async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response),
    )
    const { container } = render(<MarketplaceStatusBanner collectionSlug="banner-fail" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.querySelector('[role="status"]')).toBeNull()
  })
})
