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
