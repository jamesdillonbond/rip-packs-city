// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import { FreshnessStamp, formatFreshness, formatLocal } from "@/components/insights/FreshnessStamp"

// CONTRACT (2026-08-05): two-phase, hydration-safe, viewer-local.
//   - formatFreshness (UTC, deterministic) is the SSR + first-client-render
//     value, so the served HTML of all 18 boards carries a real timestamp for
//     crawlers/no-JS (the 2026-08-01 "—" regression must never recur) and server
//     and client hydrate to identical text.
//   - After mount the visible text swaps to the viewer's local zone.
// "—" means only "no timestamp supplied".

afterEach(() => cleanup())

describe("formatFreshness", () => {
  it("formats in UTC, independent of the runtime timezone", () => {
    expect(formatFreshness("2026-06-01T12:34:00Z")).toBe("Jun 1, 2026, 12:34 UTC")
  })

  it("zero-pads hours and minutes", () => {
    expect(formatFreshness("2026-01-09T04:05:00Z")).toBe("Jan 9, 2026, 04:05 UTC")
  })

  it("returns null for missing or unparseable input (never a fake date)", () => {
    expect(formatFreshness(null)).toBeNull()
    expect(formatFreshness(undefined)).toBeNull()
    expect(formatFreshness("")).toBeNull()
    expect(formatFreshness("not-a-date")).toBeNull()
  })

  it("is a pure function of the ISO string — the hydration-safety property", () => {
    // The old implementation used toLocaleString, whose output depends on the
    // runtime timezone (UTC on the server, local in the browser). That drift is
    // the entire reason it deferred to an effect and rendered "—". Pinning
    // determinism here is what makes rendering server-side safe.
    const iso = "2026-06-01T12:34:00Z"
    expect(formatFreshness(iso)).toBe(formatFreshness(iso))
    // Same instant expressed with a different offset must format identically.
    expect(formatFreshness("2026-06-01T08:34:00-04:00")).toBe(formatFreshness(iso))
  })
})

describe("formatLocal", () => {
  it("formats in the runtime (viewer) zone and self-labels it", () => {
    const origTZ = process.env.TZ
    process.env.TZ = "America/Los_Angeles"
    try {
      // 02:00 UTC on Jun 1 is 7:00 PM PDT on May 31 — local shifts the day.
      expect(formatLocal("2026-06-01T02:00:00Z")).toBe("May 31, 2026, 7:00 PM PDT")
    } finally {
      process.env.TZ = origTZ
    }
  })
  it("returns null for missing / unparseable input", () => {
    expect(formatLocal(null)).toBeNull()
    expect(formatLocal("not-a-date")).toBeNull()
  })
})

describe("FreshnessStamp", () => {
  it("SERVER-renders the real UTC timestamp — crawlers/no-JS never see '—'", () => {
    // renderToStaticMarkup runs no effects, i.e. exactly the served HTML. This
    // pins the 2026-08-01 property: the first paint carries a real value, in UTC.
    const html = renderToStaticMarkup(<FreshnessStamp iso="2026-06-01T12:34:00Z" />)
    expect(html).toContain("Jun 1, 2026, 12:34 UTC")
    expect(html).not.toContain("—")
  })

  it("swaps to the viewer's local zone after mount", async () => {
    const origTZ = process.env.TZ
    process.env.TZ = "America/Los_Angeles"
    try {
      const { container } = render(<FreshnessStamp iso="2026-06-01T02:00:00Z" />)
      // Post-mount the effect localizes: 02:00 UTC Jun 1 -> 7:00 PM PDT May 31.
      await waitFor(() => expect(container.textContent).toContain("May 31"))
      expect(container.textContent).toContain("PDT")
      expect(container.textContent).not.toContain("UTC")
    } finally {
      process.env.TZ = origTZ
    }
  })

  it("emits a machine-readable <time dateTime> (stable across the local swap)", () => {
    const { container } = render(<FreshnessStamp iso="2026-06-01T12:34:00Z" />)
    const el = container.querySelector("time")
    expect(el).not.toBeNull()
    expect(el!.getAttribute("dateTime")).toBe("2026-06-01T12:34:00.000Z")
  })

  it("renders '—' ONLY when no timestamp is supplied", () => {
    expect(render(<FreshnessStamp iso={null} />).container.textContent).toBe("—")
    cleanup()
    expect(render(<FreshnessStamp iso={undefined} />).container.textContent).toBe("—")
    cleanup()
    expect(render(<FreshnessStamp iso="not-a-date" />).container.textContent).toBe("—")
  })
})
