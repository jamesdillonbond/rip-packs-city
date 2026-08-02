// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { FreshnessStamp, formatFreshness } from "@/components/insights/FreshnessStamp"

// CONTRACT CHANGED 2026-08-01. FreshnessStamp used to render a literal "—" on
// the server + first client render and fill the date in a useEffect, so the
// SERVED HTML of all 18 public insights boards permanently read "—" where the
// freshness stamp belonged (verified live on /insights/candy-mlb). It now
// formats deterministically in UTC, so the value is present in the first render
// and "—" means only "no timestamp supplied".

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

describe("FreshnessStamp", () => {
  it("renders the timestamp on the FIRST render — no effect, no placeholder", () => {
    // Deliberately asserted synchronously (no waitFor): a value that only
    // appears after mount is the exact regression this replaced.
    const { container } = render(<FreshnessStamp iso="2026-06-01T12:34:00Z" />)
    expect(container.textContent).toBe("Jun 1, 2026, 12:34 UTC")
  })

  it("emits a machine-readable <time dateTime> alongside the visible text", () => {
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
