// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"
import React from "react"

import CrossCollectionBoardClient, {
  type ApiResponse,
} from "@/app/insights/cross-collection/CrossCollectionBoardClient"

// /insights/cross-collection has TWO instants in its payload and they are not
// interchangeable:
//
//   meta.fetched_at  — stamped `new Date()` by the page AND the API route at READ
//                      time. Always "just now". Says nothing about the data.
//   stats.computed_at — when the cohort mats were last rebuilt. The real age.
//
// The board is built from three materialised tables rebuilt by a daily pg_cron
// pair (rpc-ccm-step1/step2). Measured 2026-08-21: both steps had failed with
// `canceling statement due to statement timeout` on EVERY run since 08-18, so the
// whale map was 4 days 19 hours old — and the page rendered no age at all. Had it
// rendered the convenient field, it would have claimed "updated seconds ago" on
// five-day-old data, which is worse than saying nothing.
//
// So this pins the distinction rather than the presence: a stamp is only honest
// here if it moves with computed_at and ignores fetched_at.
//
// What this does NOT prove: that the mats are fresh, or that a reader interprets a
// five-day-old cohort as a problem. The refresh failure itself is filed, not fixed
// — it needs a schedule or query decision that is not autonomous.

const COMPUTED = "2026-08-17T04:10:00.000Z"
const FETCHED = "2026-08-21T23:30:00.000Z"

const initial = (over: Partial<NonNullable<ApiResponse["stats"]>> = {}): ApiResponse => ({
  meta: { fetched_at: FETCHED },
  stats: {
    cohort_size: 193,
    three_coll_wallets: 120,
    four_coll_wallets: 50,
    five_plus_coll_wallets: 23,
    cohort_total_moments: 40000,
    avg_moments_per_wallet: 207,
    median_moments_per_wallet: 150,
    cohort_total_fmv_usd: 1000000,
    computed_at: COMPUTED,
    ...over,
  },
  wallets: [],
  ts_set_overlap: [],
})

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("the whale map shows when its data was COMPUTED, not when it was read", () => {
  it("stamps stats.computed_at", () => {
    const { container } = render(<CrossCollectionBoardClient initial={initial()} />)
    const t = container.querySelector("time")
    expect(t, "no <time> element — the cohort's age is not on screen").not.toBeNull()
    expect(t!.getAttribute("dateTime")).toBe(COMPUTED)
  })

  it("does NOT fall back to meta.fetched_at when computed_at is missing", () => {
    // The whole failure mode in one case: fetched_at is present and inviting, and
    // using it would render a fresh-looking timestamp over stale data. "—" is the
    // correct output — it means "no timestamp was supplied", which is true.
    const { container } = render(<CrossCollectionBoardClient initial={initial({ computed_at: null })} />)
    expect(container.textContent).not.toContain("2026-08-21")
    expect(container.textContent).toMatch(/computed\s*—/i)
    expect(container.querySelector("time")).toBeNull()
  })

  it("renders no age at all rather than a wrong one when stats is null", () => {
    // A failed stats leg nulls the whole object. The board still renders (the other
    // two legs may have succeeded); it must not borrow the read clock to fill the gap.
    const withoutStats: ApiResponse = { ...initial(), stats: null }
    const { container } = render(<CrossCollectionBoardClient initial={withoutStats} />)
    expect(container.querySelector("time")).toBeNull()
    expect(container.textContent).not.toContain("2026-08-21")
  })
})
