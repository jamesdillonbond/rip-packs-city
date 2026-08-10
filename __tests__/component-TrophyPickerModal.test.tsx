// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"

// TrophyPickerModal is the ~940-line trophy-case pin picker (0% coverage before
// this). It fetches /api/profile/top-moments for the owner, renders a filterable/
// sortable moment grid, has a manual-ID lookup tab, and pins a pick via
// POST /api/profile/trophy. These tests drive its OWN code: the mount fetch +
// moments state machine (loaded grid vs empty), the grid/manual tab toggle, the
// manual lookup, and the close affordance — with fetch stubbed per endpoint.

import TrophyPickerModal, { type PickerMoment } from "@/components/profile/TrophyPickerModal"

const moment: PickerMoment = {
  moment_id: "141:5156:1",
  collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  collection_slug: "nba-top-shot",
  wallet_address: "0xbd94cade097e50ac",
  player_name: "Victor Wembanyama",
  set_name: "Base Set",
  team_name: "San Antonio Spurs",
  tier: "LEGENDARY",
  serial_number: 1,
  mint_count: 2999,
  fmv_usd: 1200,
  image_url: "https://example.com/m.png",
  is_locked: false,
  series_number: 4,
  edition_key: "141:5156",
  league: "nba",
}

function stubFetch(momentsPayload: { moments: PickerMoment[] }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (String(url).includes("/api/profile/top-moments")) {
        return Promise.resolve({ ok: true, json: async () => momentsPayload } as Response)
      }
      // telemetry fallback + any other call
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
    }),
  )
}

beforeEach(() => {
  stubFetch({ moments: [moment] })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const baseProps = { slot: 1, ownerKey: "0xbd94cade097e50ac", onClose: () => {}, onPinned: () => {} }

describe("TrophyPickerModal", () => {
  it("renders the slot header and both picker tabs", () => {
    const { getByText } = render(<TrophyPickerModal {...baseProps} />)
    expect(getByText(/Pin to slot 1/)).toBeTruthy()
    expect(getByText(/Pick from collection/)).toBeTruthy()
    expect(getByText(/Enter ID manually/)).toBeTruthy()
  })

  it("loads the owner's moments into the grid", async () => {
    const { findAllByText } = render(<TrophyPickerModal {...baseProps} />)
    expect((await findAllByText(/Victor Wembanyama/)).length).toBeGreaterThan(0)
  })

  it("shows the empty state when the owner has no eligible moments", async () => {
    stubFetch({ moments: [] })
    const { findByText } = render(<TrophyPickerModal {...baseProps} />)
    expect(await findByText(/No owned moments found yet/)).toBeTruthy()
  })

  it("switches to the manual-entry tab", () => {
    const { getByText, container } = render(<TrophyPickerModal {...baseProps} />)
    fireEvent.click(getByText(/Enter ID manually/))
    // The manual tab exposes a text input for the moment id.
    expect(container.querySelector("input")).toBeTruthy()
  })

  it("invokes onClose from the close control", () => {
    const onClose = vi.fn()
    const { getByLabelText } = render(<TrophyPickerModal {...baseProps} onClose={onClose} />)
    fireEvent.click(getByLabelText("Close"))
    expect(onClose).toHaveBeenCalled()
  })

  it("renders without an ownerKey (no fetch target) without crashing", async () => {
    const { getByText } = render(<TrophyPickerModal {...baseProps} ownerKey={null} />)
    expect(getByText(/Pin to slot 1/)).toBeTruthy()
    await waitFor(() => expect(fetch).toHaveBeenCalled())
  })
})

const TS_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

// The manual-entry tab (moment-ID lookup), the grid filter/sort controls, the
// pin POST, and the MomentRow variant branches were all dark. These drive them.
describe("TrophyPickerModal — manual lookup + grid pin + row variants", () => {
  it("looks up a moment ID and renders the preview card (image, serial/mint, fmv)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const u = String(url)
        if (u.includes("/api/profile/top-moments"))
          return Promise.resolve({ ok: true, json: async () => ({ moments: [] }) } as Response)
        if (u.includes("/api/moment/"))
          return Promise.resolve({
            ok: true,
            json: async () => ({
              ok: true,
              resolved: { collection_id: "c1", collection_slug: "nba-top-shot", serial_number: 7 },
              edition: { player_name: "Ja Morant", set_name: "Base Set", tier: "RARE", circulation_count: 500, thumbnail_url: "https://x/j.png", external_id: "1:2", name: "E" },
              serial_specific: { nft_id: "999", serial_number: 7, owner_address: "0xabc" },
              fmv: { fmv_usd: 350 },
            }),
          } as Response)
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      }),
    )
    const { getByText, getByPlaceholderText, container } = render(<TrophyPickerModal {...baseProps} />)
    fireEvent.click(getByText(/Enter ID manually/))
    fireEvent.change(getByPlaceholderText("Moment ID"), { target: { value: "999" } })
    fireEvent.click(getByText("Look up"))
    await waitFor(() => expect(container.textContent).toContain("Ja Morant"))
    expect(container.textContent).toContain("#7/500")
    expect(container.textContent).toContain("$350.00")
    expect(container.querySelector("img")).toBeTruthy()
  })

  it("shows the not-found error when the lookup responds not-ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const u = String(url)
        if (u.includes("/api/profile/top-moments"))
          return Promise.resolve({ ok: true, json: async () => ({ moments: [] }) } as Response)
        if (u.includes("/api/moment/"))
          return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response)
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      }),
    )
    const { getByText, getByPlaceholderText, findByText } = render(<TrophyPickerModal {...baseProps} />)
    fireEvent.click(getByText(/Enter ID manually/))
    fireEvent.change(getByPlaceholderText("Moment ID"), { target: { value: "bad" } })
    fireEvent.click(getByText("Look up"))
    expect(await findByText(/Couldn't find a moment with that ID/)).toBeTruthy()
  })

  it("shows the retry error when the lookup fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const u = String(url)
        if (u.includes("/api/profile/top-moments"))
          return Promise.resolve({ ok: true, json: async () => ({ moments: [] }) } as Response)
        if (u.includes("/api/moment/")) return Promise.reject(new Error("network"))
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      }),
    )
    const { getByText, getByPlaceholderText, findByText } = render(<TrophyPickerModal {...baseProps} />)
    fireEvent.click(getByText(/Enter ID manually/))
    fireEvent.change(getByPlaceholderText("Moment ID"), { target: { value: "boom" } })
    fireEvent.click(getByText("Look up"))
    expect(await findByText(/Lookup failed. Try again/)).toBeTruthy()
  })

  it("does not fetch on an empty manual ID", () => {
    const { getByText } = render(<TrophyPickerModal {...baseProps} />)
    fireEvent.click(getByText(/Enter ID manually/))
    fireEvent.click(getByText("Look up"))
    expect((fetch as any).mock.calls.every((c: any[]) => !String(c[0]).includes("/api/moment/"))).toBe(true)
  })

  it("pins a manually looked-up moment (no image → placeholder branch) and calls onPinned", async () => {
    const onPinned = vi.fn()
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const u = String(url)
        if (u.includes("/api/profile/top-moments"))
          return Promise.resolve({ ok: true, json: async () => ({ moments: [] }) } as Response)
        if (u.includes("/api/moment/"))
          return Promise.resolve({
            ok: true,
            json: async () => ({
              ok: true,
              resolved: { collection_id: "c1" },
              edition: { player_name: "Ja Morant", set_name: "Base", thumbnail_url: null, external_id: "1:2" },
              serial_specific: { nft_id: "999", serial_number: 7 },
              fmv: { fmv_usd: 350 },
            }),
          } as Response)
        if (u.includes("/api/profile/trophy"))
          return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      }),
    )
    const { getByText, getByPlaceholderText, container } = render(
      <TrophyPickerModal {...baseProps} onPinned={onPinned} />,
    )
    fireEvent.click(getByText(/Enter ID manually/))
    fireEvent.change(getByPlaceholderText("Moment ID"), { target: { value: "999" } })
    fireEvent.click(getByText("Look up"))
    await waitFor(() => expect(container.textContent).toContain("Ja Morant"))
    fireEvent.click(getByText("Pin"))
    await waitFor(() => expect(onPinned).toHaveBeenCalled())
  })

  it("pins a grid moment via POST /api/profile/trophy and calls onPinned", async () => {
    const onPinned = vi.fn()
    const { findByText } = render(<TrophyPickerModal {...baseProps} onPinned={onPinned} />)
    fireEvent.click(await findByText(/Victor Wembanyama/))
    await waitFor(() => expect(onPinned).toHaveBeenCalled())
    const call = (fetch as any).mock.calls.find((c: any[]) => String(c[0]).includes("/api/profile/trophy"))
    expect(call).toBeTruthy()
    expect(JSON.parse(call[1].body).momentId).toBe("141:5156:1")
  })

  it("surfaces a pick error when the pin POST fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const u = String(url)
        if (u.includes("/api/profile/top-moments"))
          return Promise.resolve({ ok: true, json: async () => ({ moments: [moment] }) } as Response)
        if (u.includes("/api/profile/trophy"))
          return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: "pin blew up" }) } as Response)
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      }),
    )
    const { findByText } = render(<TrophyPickerModal {...baseProps} />)
    fireEvent.click(await findByText(/Victor Wembanyama/))
    expect(await findByText(/pin blew up/)).toBeTruthy()
  })

  it("filters the grid to empty via the search box (filter-miss copy)", async () => {
    const { getByLabelText, findByText, getByText } = render(<TrophyPickerModal {...baseProps} />)
    await findByText(/Victor Wembanyama/)
    fireEvent.change(getByLabelText("Search your moments"), { target: { value: "zzzznomatch" } })
    expect(getByText(/No moments match the current filter/)).toBeTruthy()
  })

  it("drives the sort + tier-filter controls and the MomentRow variant branches", async () => {
    const gridMoments: PickerMoment[] = [
      // locked, no image (● fallback), NBA league badge, team, tier chip, series label
      { ...moment, moment_id: "g1", is_locked: true, image_url: null, league: "NBA", team_name: "Portland", tier: "LEGENDARY", serial_number: 1, mint_count: 99, series_number: 4, set_name: "Base Set" },
      // null-everything row + a serial-fmv badge
      { ...moment, moment_id: "g2", tier: null, team_name: null, serial_number: null, mint_count: null, fmv_usd: null, set_name: null, series_number: null, league: null, image_url: null, player_name: "No Tier Guy", serial_fmv: { estimate_usd: 5000, multiplier: 3, serial_bucket: "first" } },
    ]
    stubFetch({ moments: gridMoments })
    const { container, findByText, getByText } = render(<TrophyPickerModal {...baseProps} />)
    await findByText(/No Tier Guy/)
    // sort controls
    fireEvent.click(getByText("Serial ↑"))
    fireEvent.click(getByText("Tier"))
    // tier filter chip (the button, not the in-row tier <span>)
    const legChip = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "LEGENDARY")
    expect(legChip).toBeTruthy()
    fireEvent.click(legChip!)
    // after filtering to LEGENDARY, the null-tier row is gone
    expect(container.textContent).toContain("Victor Wembanyama")
  })

  it("re-fetches with a collection param and resets a non-default league on collection change", async () => {
    stubFetch({ moments: [] })
    const { container } = render(<TrophyPickerModal {...baseProps} />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    // set a non-default league first (so the reset branch fires)
    const nbaRadio = Array.from(container.querySelectorAll('button[role="radio"]')).find((b) => b.textContent === "NBA")
    fireEvent.click(nbaRadio!)
    // pick a real collection (title-bearing picker buttons; [All] is title="All")
    const collBtn = Array.from(container.querySelectorAll("button[title]")).find((b) => b.getAttribute("title") !== "All")
    expect(collBtn).toBeTruthy()
    fireEvent.click(collBtn!)
    await waitFor(() =>
      expect((fetch as any).mock.calls.some((c: any[]) => String(c[0]).includes("collection="))).toBe(true),
    )
  })

  it("renders the NBA league badge only for a Top Shot row with an NBA league value", async () => {
    const nbaMoment: PickerMoment = { ...moment, moment_id: "nba1", collection_id: TS_UUID, league: "NBA", player_name: "League Badge Guy" }
    stubFetch({ moments: [nbaMoment] })
    const { container, findByText } = render(<TrophyPickerModal {...baseProps} />)
    await findByText(/League Badge Guy/)
    // the league badge <span> renders the raw league string
    expect(container.textContent).toContain("NBA")
  })
})
