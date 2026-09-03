// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"
import PriceAlertsCard from "@/components/profile/PriceAlertsCard"

// Drives the profile Price Alerts card: fetch /api/alerts, loading/error/empty/
// list, the null player fallback, the Pause/Resume toggle (PATCH, updates the
// row), and the Delete (confirm → DELETE → drop the row). The describeAlert/
// formatAlertWhen copy helpers are tested separately (profile-price-alert-format).

let fetchMock: ReturnType<typeof vi.fn>
const okJson = (b: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(b) } as Response)

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
  vi.stubGlobal("confirm", vi.fn(() => true))
  vi.stubGlobal("alert", vi.fn())
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const alerts = [
  {
    id: "a1",
    owner_key: "0xowner",
    edition_key: "1:2",
    player_name: "Anthony Edwards",
    set_name: "Base",
    alert_type: "below",
    threshold: 50,
    channel: "email",
    notification_email: "x@y.com",
    active: true,
    last_triggered_at: null,
    created_at: "2026-04-01",
  },
  {
    id: "a2",
    owner_key: "0xowner",
    edition_key: "3:4",
    player_name: null, // → "Unknown player"
    set_name: null,
    alert_type: "below",
    threshold: 10,
    channel: "email",
    notification_email: null,
    active: false,
    last_triggered_at: null,
    created_at: "2026-04-02",
  },
]

describe("PriceAlertsCard", () => {
  it("renders the alert list with the null-player fallback", async () => {
    fetchMock.mockReturnValueOnce(okJson(alerts))
    const { getByText } = render(<PriceAlertsCard ownerKey="0xowner" />)
    await waitFor(() => expect(getByText("Anthony Edwards")).toBeTruthy())
    expect(getByText("Unknown player")).toBeTruthy()
    // fetch pulled inactive rows too, scoped to the owner
    expect(fetchMock.mock.calls[0][0]).toContain("include_inactive=1")
    expect(fetchMock.mock.calls[0][0]).toContain("owner_key=0xowner")
  })

  it("shows the empty state when there are no alerts", async () => {
    fetchMock.mockReturnValueOnce(okJson([]))
    const { getByText } = render(<PriceAlertsCard ownerKey="0xowner" />)
    await waitFor(() => expect(getByText(/No price alerts set/)).toBeTruthy())
  })

  it("shows an error message when the load fails", async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: false, status: 500 } as Response))
    const { getByText, queryByText } = render(<PriceAlertsCard ownerKey="0xowner" />)
    await waitFor(() => expect(getByText("Failed to load alerts")).toBeTruthy())
    // The failure must not ALSO conclude "No price alerts set" — before
    // 2026-09-03 the catch wrote `[]` into the list and both rendered.
    expect(queryByText(/No price alerts set/)).toBeNull()
  })

  it("Pause issues a PATCH toggling active off", async () => {
    fetchMock.mockReturnValueOnce(okJson(alerts))
    fetchMock.mockReturnValueOnce(okJson({ active: false })) // PATCH response
    const { getAllByText } = render(<PriceAlertsCard ownerKey="0xowner" />)
    await waitFor(() => expect(getAllByText("Pause").length).toBeGreaterThan(0))
    fireEvent.click(getAllByText("Pause")[0]) // the active row (a1)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const patch = fetchMock.mock.calls[1]
    expect(patch[1].method).toBe("PATCH")
    expect(JSON.parse(patch[1].body)).toEqual({ id: "a1", owner_key: "0xowner", active: false })
  })

  it("Delete confirms, DELETEs, and drops the row", async () => {
    fetchMock.mockReturnValueOnce(okJson(alerts))
    fetchMock.mockReturnValueOnce(okJson({ ok: true })) // DELETE
    const { getAllByText, queryByText } = render(<PriceAlertsCard ownerKey="0xowner" />)
    await waitFor(() => expect(getAllByText("Delete").length).toBe(2))
    fireEvent.click(getAllByText("Delete")[0]) // delete a1
    await waitFor(() => expect(queryByText("Anthony Edwards")).toBeNull())
    const del = fetchMock.mock.calls[1]
    expect(del[1].method).toBe("DELETE")
    expect(del[0]).toContain("id=a1")
    expect(del[0]).toContain("owner_key=0xowner")
  })

  it("does not fetch when ownerKey is empty", () => {
    render(<PriceAlertsCard ownerKey="" />)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
