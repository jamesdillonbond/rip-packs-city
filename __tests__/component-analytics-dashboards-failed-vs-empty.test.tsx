// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, waitFor, screen } from "@testing-library/react"

vi.mock("@/components/analytics/KpiCard", () => ({ default: () => null }))

import ListingsDashboard from "@/components/analytics/ListingsDashboard"
import PulseDashboard from "@/components/analytics/PulseDashboard"

// A failed read on the analytics dashboards must not render as an empty market.
//
// ── WHY THESE TWO, AND WHY A RENDER TEST RATHER THAN A SOURCE GUARD ─────────
// Found by extending the client-page copy census into `components/**`. The page
// sweep's premise was that components are "not a blind spot in the same way"
// because the component gate measures them — but /insights/pack-reality already
// proved that coverage asks whether a line RAN, not whether the sentence it
// printed was TRUE. Both of these files were in the gate and both shipped this.
//
// Measured: only 5 of the 14 fetching files under components/analytics/ import
// `fetchJson`, the helper whose own header names this directory as the reason it
// exists. These two were the only ones carrying claim-copy with no failure
// variable at all.
//
// ── THE MECHANISM, WHICH IS NASTIER THAN A BARE CATCH ───────────────────────
// Both fetched with `fetch(url).then((r) => r.json())` and NO `r.ok` check, then
// cast the parsed body straight to the success type:
//
//     setSummary((s as ListingsSummaryResponse) ?? null)
//
// Our API routes answer a failure with a well-formed JSON envelope
// (`apiErrorResponse` → `{ error, code, retryable }`). So on a 503 the body
// PARSES FINE, the promise RESOLVES, and the `.catch(() => {})` never fires.
// The error object is cast to the row type, `?.rows` reads undefined, and the
// table states "No open offers match the current filters."
//
// ⚠ Note the direction of that interaction: hardening the SERVER to return a
// clean JSON error envelope made this client bug *quieter*, not louder. A route
// that used to blow up the parse now returns something that looks like data.
//
// Every case below drives that exact scenario — a non-2xx WITH a valid JSON
// body — because a fixture that fails the parse would take the `.catch` and
// would have passed against the defective code.

type Leg = "ok" | "fail"

/** A 5xx carrying a well-formed JSON error envelope, exactly as our routes do. */
const errorEnvelope = {
  ok: false,
  status: 503,
  json: async () => ({ error: "Service temporarily unavailable", code: "unavailable", retryable: true }),
}
const success = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

function listingsFetch(summary: Leg, offers: Leg) {
  return vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes("/listings/summary")) {
      return (summary === "ok" ? success({ collections: {}, rows: [], marketplace_listings: [] }) : errorEnvelope) as any
    }
    return (offers === "ok" ? success({ rows: [] }) : errorEnvelope) as any
  })
}

function pulseFetch(activity: Leg) {
  return vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes("/pulse/activity")) {
      return (activity === "ok" ? success({ rows: [] }) : errorEnvelope) as any
    }
    return success(u.includes("/pulse/24h") ? {} : { rows: [] }) as any
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("ListingsDashboard — a failed read is not an empty book", () => {
  it("a 503 with a JSON body does NOT render 'No open offers match the current filters.'", async () => {
    vi.stubGlobal("fetch", listingsFetch("ok", "fail"))
    render(<ListingsDashboard />)

    await waitFor(() => expect(screen.getByText(/Couldn't load open offers just now/)).toBeTruthy())
    // The claim itself must be absent, not merely accompanied by an error.
    expect(screen.queryByText("No open offers match the current filters.")).toBeNull()
  })

  it("a genuinely empty book STILL says so", async () => {
    // The other direction, and the one that keeps the fix honest: turning every
    // empty state into "unavailable" would only move the dishonesty.
    vi.stubGlobal("fetch", listingsFetch("ok", "ok"))
    render(<ListingsDashboard />)

    await waitFor(() =>
      expect(screen.getByText("No open offers match the current filters.")).toBeTruthy(),
    )
    expect(screen.queryByText(/Couldn't load open offers/)).toBeNull()
  })

  it("the two legs fail independently — a summary outage does not blank the offers table", async () => {
    vi.stubGlobal("fetch", listingsFetch("fail", "ok"))
    render(<ListingsDashboard />)

    await waitFor(() => expect(screen.getByText(/Couldn't load marketplace data just now/)).toBeTruthy())
    // Offers loaded fine, so its section must report the truth about itself.
    expect(screen.getByText("No open offers match the current filters.")).toBeTruthy()
    expect(screen.queryByText(/Couldn't load open offers/)).toBeNull()
  })
})

describe("PulseDashboard — a failed read is not a quiet market", () => {
  it("a 503 with a JSON body does NOT render 'No events match the current filters.'", async () => {
    vi.stubGlobal("fetch", pulseFetch("fail"))
    render(<PulseDashboard />)

    await waitFor(() => expect(screen.getByText(/Couldn't load activity just now/)).toBeTruthy())
    expect(screen.queryByText("No events match the current filters.")).toBeNull()
  })

  it("a genuinely quiet window STILL says so", async () => {
    vi.stubGlobal("fetch", pulseFetch("ok"))
    render(<PulseDashboard />)

    await waitFor(() => expect(screen.getByText("No events match the current filters.")).toBeTruthy())
    expect(screen.queryByText(/Couldn't load activity/)).toBeNull()
  })

  it("no failure copy diagnoses a cause it cannot know", async () => {
    // The /[collection]/sniper lesson: the copy this class replaces was often a
    // confident WRONG explanation ("Benchmark data may be too thin"), and a
    // replacement that guesses a different wrong cause is the same mistake in
    // new words.
    vi.stubGlobal("fetch", pulseFetch("fail"))
    render(<PulseDashboard />)

    const el = await screen.findByText(/Couldn't load activity just now/)
    expect(el.textContent ?? "").not.toMatch(
      /too thin|not indexed|no coverage|try a (longer|different)|lower your|adjust your/i,
    )
  })
})
