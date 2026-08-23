// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import React from "react"

import RookiesBoardClient, { type ApiResponse as RookiesResponse } from "@/app/insights/rookies/RookiesBoardClient"
import FirstMintBoardClient, { type ApiResponse as FirstMintResponse } from "@/app/insights/first-mint/FirstMintBoardClient"
import DealsBoardClient from "@/app/insights/deals/DealsBoardClient"
import PaniniSqueezeClient from "@/app/insights/panini-squeeze/PaniniSqueezeClient"

// The source guard (cached-boards-surface-their-snapshot-age) proves the tag is
// PRESENT. This proves it renders the SNAPSHOT'S instant rather than the render
// clock — the distinction that matters, because both boards are served through
// readBoardOrLive's stale-cache leg, which hands back the last-good snapshot at any
// age with no degraded notice. `first-mint` failed 63.7% of its warm ticks over the
// 48h to 2026-08-21 and reached 5.6h stale, so "old snapshot" is the ordinary case.
//
// Assertions read <time dateTime>, not the visible text: FreshnessStamp formats in
// UTC for SSR and swaps to the viewer's zone after mount, so the text is
// environment-dependent by design while dateTime is the machine-readable instant.
//
// ⚠ EXTENDED 2026-08-22. "The age of the data they are serving" gained a second layer
// when three boards were materialised: the SNAPSHOT instant is no longer the oldest
// thing in the payload — the MV's refresh instant is. A board that stamps the snapshot
// while its rows came from a 30-minute-old MV is understating staleness on a surface
// whose subject is listings that disappear. first-mint's fixture below therefore supplies
// a LATER fetched_at than data_as_of, so a regression to the request clock reddens here.

const SNAPSHOT_ISO = "2026-08-15T04:30:00.000Z"

const rookiesInitial = (fetchedAt: string | undefined): RookiesResponse =>
  ({
    meta: fetchedAt === undefined ? ({} as { fetched_at: string }) : { fetched_at: fetchedAt },
    cohort_stats: null,
    rows: [],
  })

// ⚠ first-mint diverges from rookies since 2026-08-22: its board reads a MATERIALIZED
// view, so the rows can be a full refresh interval older than the snapshot that carries
// them. It therefore stamps `meta.data_as_of` (when the rows were computed) rather than
// `meta.fetched_at` (when the fetch answered). rookies is still live-computed, where the
// two coincide and `fetched_at` remains correct.
//
// The fixture sets fetched_at to a DIFFERENT, LATER instant on purpose: that turns this
// from "renders some timestamp" into "prefers the age of the DATA over the age of the
// REQUEST", which is precisely the regression the materialisation introduced.
const firstMintInitial = (dataAsOf: string | undefined): FirstMintResponse =>
  ({
    meta:
      dataAsOf === undefined
        ? ({} as { fetched_at: string })
        : { fetched_at: "2026-08-21T19:45:00.000Z", data_as_of: dataAsOf },
    stats: null,
    trophies: [],
  }) as unknown as FirstMintResponse

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const BOARDS = [
  { name: "rookies", Client: RookiesBoardClient, initial: rookiesInitial },
  { name: "first-mint", Client: FirstMintBoardClient, initial: firstMintInitial },
] as const

describe("snapshot-cached boards render the age of the data they are serving", () => {
  for (const { name, Client, initial } of BOARDS) {
    it(`${name} stamps the SNAPSHOT's instant, not the render clock`, async () => {
      // A clock far from the snapshot: if the component ever defaulted to `now`,
      // dateTime would carry 2026-08-21 instead of the snapshot's 2026-08-15.
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2026-08-21T19:45:00.000Z"))
      const C = Client as unknown as React.ComponentType<{ initial: unknown }>
      const { container } = render(<C initial={initial(SNAPSHOT_ISO)} />)
      const t = container.querySelector("time")
      expect(t, `${name}: no <time> element — the snapshot age is not on screen`).not.toBeNull()
      expect(t!.getAttribute("dateTime")).toBe(SNAPSHOT_ISO)
    })

    it(`${name} renders "—" rather than inventing a time when none was supplied`, async () => {
      const C = Client as unknown as React.ComponentType<{ initial: unknown }>
      const { container } = render(<C initial={initial(undefined)} />)
      await waitFor(() => {
        expect(container.textContent).toMatch(/Updated\s*—/)
      })
      // No <time> at all: "—" must not be paired with a fabricated machine-readable
      // instant that crawlers and assistive tech would read as a real freshness claim.
      expect(container.querySelector("time")).toBeNull()
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// The two MATERIALIZED boards whose clients take bespoke props, so they cannot
// join the parametrised loop above — and which were therefore OUTSIDE this
// guard's population on 2026-08-22, the day their freshness stamp regressed.
//
// ⚠ That is the lesson worth keeping: this file already pinned "render the age of
// the DATA, not the render clock", and it still passed while /insights/deals told
// collectors "Updated just now" about rows up to 30 minutes old — because `deals`
// and `panini-squeeze` were never in BOARDS. A guard's blast radius is fixed by
// how its population is DERIVED, and a hand-listed population drifts away from
// the thing it is meant to cover. Both are added here explicitly.
// ─────────────────────────────────────────────────────────────────────────────
const MATERIALIZED = [
  {
    name: "deals",
    // page.tsx feeds initialFetchedAt from payload.data_as_of (the MV's refresh
    // instant), NOT from meta.fetched_at (when the request was answered).
    render: (iso: string | null) =>
      React.createElement(DealsBoardClient as unknown as React.ComponentType<any>, {
        initialRows: [],
        initialFetchedAt: iso,
      }),
  },
  {
    name: "panini-squeeze",
    render: (iso: string | null) =>
      React.createElement(PaniniSqueezeClient as unknown as React.ComponentType<any>, {
        initialRows: [],
        fetchedAt: iso,
        coverage: null,
        totals: null,
        degraded: null,
      }),
  },
] as const

describe("materialized boards stamp the MV's instant, not the render clock", () => {
  for (const { name, render: renderBoard } of MATERIALIZED) {
    it(`${name} renders the supplied data instant`, () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2026-08-21T19:45:00.000Z"))
      const { container } = render(renderBoard(SNAPSHOT_ISO))
      const t = container.querySelector("time")
      expect(t, `${name}: no <time> — the data age is not on screen`).not.toBeNull()
      // Not the fake "now": a regression to the request clock would put 08-21 here.
      expect(t!.getAttribute("dateTime")).toBe(SNAPSHOT_ISO)
    })

    it(`${name} renders "—" rather than inventing a time when the age is unknown`, () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2026-08-21T19:45:00.000Z"))
      const { container } = render(renderBoard(null))
      // The whole point of returning null from readMvAsOf: unknown must LOOK unknown.
      // A <time> here would be a machine-readable freshness claim we cannot support,
      // and crawlers and assistive tech would read it as real.
      expect(container.querySelector("time")).toBeNull()
      expect(container.textContent).toMatch(/—/)
    })
  }
})
