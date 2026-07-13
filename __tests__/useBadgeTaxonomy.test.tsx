// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import {
  useBadgeTaxonomy,
  lookupBadge,
  classesForColorFamily,
  COLOR_FAMILY_CLASSES,
  type BadgeMeta,
} from "@/lib/badges/useBadgeTaxonomy"

// useBadgeTaxonomy(titles, collectionId) POSTs /api/badge-taxonomy and returns a
// live title→BadgeMeta map, starting {} and filling on success (or staying {} on
// error). It memoizes per (collectionId + sorted-unique-normalized-titles) key in
// process-lifetime Maps, so each test uses a DISTINCT title set to avoid cache
// bleed. We also pin the pure helpers lookupBadge / classesForColorFamily.

let fetchMock: ReturnType<typeof vi.fn>

function mockOk(taxonomy: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ taxonomy }) } as Response)
}
function mockErr(status: number, body: unknown = {}) {
  return Promise.resolve({ ok: false, status, json: () => Promise.resolve(body) } as Response)
}

const META = (over: Partial<BadgeMeta> = {}): BadgeMeta => ({
  title: "Rookie Year",
  category: "milestone",
  color_family: "gold",
  icon_url: null,
  priority: 1,
  description: null,
  ...over,
})

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("useBadgeTaxonomy", () => {
  it("returns an empty map and never fetches when titles are empty (key ends in ::)", async () => {
    const { result } = renderHook(() => useBadgeTaxonomy([], "cA"))
    expect(result.current).toEqual({})
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("ignores blank/whitespace titles that normalize to nothing", async () => {
    const { result } = renderHook(() => useBadgeTaxonomy(["   ", "!!!"], "cBlank"))
    expect(result.current).toEqual({})
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("starts empty then fills the map on a successful fetch", async () => {
    const map = { rookieyear: META() }
    fetchMock.mockReturnValue(mockOk(map))
    const { result } = renderHook(() => useBadgeTaxonomy(["Rookie Year"], "cSuccess"))

    expect(result.current).toEqual({})
    await waitFor(() => expect(result.current).toEqual(map))

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/badge-taxonomy",
      expect.objectContaining({ method: "POST" })
    )
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body)
    expect(body).toEqual({ titles: ["Rookie Year"], collectionId: "cSuccess" })
  })

  it("defaults to an empty map when the response omits taxonomy", async () => {
    fetchMock.mockReturnValue(mockOk(undefined))
    const { result } = renderHook(() => useBadgeTaxonomy(["Championship"], "cNoTax"))
    // Give the effect a tick; the resolved map is {}.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(result.current).toEqual({})
  })

  it("stays empty (no throw) when the fetch returns a non-ok status", async () => {
    fetchMock.mockReturnValue(mockErr(500, { error: "boom" }))
    const { result } = renderHook(() => useBadgeTaxonomy(["MVP"], "cErr"))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(result.current).toEqual({})
  })

  it("stays empty when fetch rejects outright", async () => {
    fetchMock.mockRejectedValue(new Error("network down"))
    const { result } = renderHook(() => useBadgeTaxonomy(["Finals"], "cReject"))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(result.current).toEqual({})
  })

  it("serves the cached map on remount without re-fetching (result cache)", async () => {
    const map = { allstar: META({ title: "All Star", color_family: "red" }) }
    fetchMock.mockReturnValue(mockOk(map))

    const first = renderHook(() => useBadgeTaxonomy(["All Star"], "cCache"))
    await waitFor(() => expect(first.result.current).toEqual(map))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    first.unmount()

    const second = renderHook(() => useBadgeTaxonomy(["All Star"], "cCache"))
    // Cache hit → synchronous, no second network call.
    expect(second.result.current).toEqual(map)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("dedups concurrent mounts of the same key into a single in-flight fetch", async () => {
    const map = { debut: META({ title: "Debut", color_family: "cyan" }) }
    fetchMock.mockReturnValue(mockOk(map))

    const a = renderHook(() => useBadgeTaxonomy(["Debut"], "cInflight"))
    const b = renderHook(() => useBadgeTaxonomy(["Debut"], "cInflight"))
    await waitFor(() => expect(a.result.current).toEqual(map))
    await waitFor(() => expect(b.result.current).toEqual(map))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("keys the cache by collectionId so the same titles refetch per collection", async () => {
    fetchMock.mockReturnValue(mockOk({ x: META() }))
    const one = renderHook(() => useBadgeTaxonomy(["Shared Title"], "colOne"))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    one.unmount()

    const two = renderHook(() => useBadgeTaxonomy(["Shared Title"], "colTwo"))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    two.unmount()
  })
})

describe("lookupBadge", () => {
  const map = { rookieyear: META() }
  it("resolves a badge by its normalized key regardless of input casing/format", () => {
    expect(lookupBadge(map, "ROOKIE_YEAR")).toBe(map.rookieyear)
    expect(lookupBadge(map, "Rookie Year")).toBe(map.rookieyear)
  })
  it("returns null for an unknown title", () => {
    expect(lookupBadge(map, "Nonexistent")).toBeNull()
  })
})

describe("classesForColorFamily", () => {
  it("returns the mapped classes for a known family", () => {
    expect(classesForColorFamily("gold")).toBe(COLOR_FAMILY_CLASSES.gold)
    expect(classesForColorFamily("emerald")).toBe(COLOR_FAMILY_CLASSES.emerald)
  })
  it("falls back to neutral for null/undefined/unknown families", () => {
    expect(classesForColorFamily(null)).toBe(COLOR_FAMILY_CLASSES.neutral)
    expect(classesForColorFamily(undefined)).toBe(COLOR_FAMILY_CLASSES.neutral)
    expect(classesForColorFamily("chartreuse")).toBe(COLOR_FAMILY_CLASSES.neutral)
  })
})
