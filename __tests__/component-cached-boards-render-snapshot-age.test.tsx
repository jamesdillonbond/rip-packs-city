// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import React from "react"

import RookiesBoardClient, { type ApiResponse as RookiesResponse } from "@/app/insights/rookies/RookiesBoardClient"
import FirstMintBoardClient, { type ApiResponse as FirstMintResponse } from "@/app/insights/first-mint/FirstMintBoardClient"

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

const SNAPSHOT_ISO = "2026-08-15T04:30:00.000Z"

const rookiesInitial = (fetchedAt: string | undefined): RookiesResponse =>
  ({
    meta: fetchedAt === undefined ? ({} as { fetched_at: string }) : { fetched_at: fetchedAt },
    cohort_stats: null,
    rows: [],
  })

const firstMintInitial = (fetchedAt: string | undefined): FirstMintResponse =>
  ({
    meta: fetchedAt === undefined ? ({} as { fetched_at: string }) : { fetched_at: fetchedAt },
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
