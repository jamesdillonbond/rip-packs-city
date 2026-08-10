// @vitest-environment jsdom
//
// lib/active-collection.ts is measured by the PRIMARY coverage gate (lib/**),
// which runs in the node environment where `typeof window === "undefined"` is
// always true — so the localStorage read/write branches were structurally
// unreachable and untested. This file is jsdom-tagged (a .test.ts, so it runs
// under the primary config, not the component config) to drive the browser
// branches, plus a stubbed-window case for the SSR guard.
import { afterEach, describe, expect, it, vi } from "vitest"
import { getLastCollection, setLastCollection } from "@/lib/active-collection"

const KEY = "rpc_last_collection"
const DEFAULT = "nba-top-shot"

afterEach(() => {
  vi.unstubAllGlobals()
  try {
    localStorage.clear()
  } catch {
    /* ignore */
  }
})

describe("active-collection (browser)", () => {
  it("returns the default when nothing is stored", () => {
    localStorage.removeItem(KEY)
    expect(getLastCollection()).toBe(DEFAULT)
  })

  it("round-trips a stored collection id", () => {
    setLastCollection("nfl-all-day")
    expect(localStorage.getItem(KEY)).toBe("nfl-all-day")
    expect(getLastCollection()).toBe("nfl-all-day")
  })

  it("falls back to the default when getItem throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {},
    })
    expect(getLastCollection()).toBe(DEFAULT)
  })

  it("swallows a setItem failure (quota / blocked storage)", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota")
      },
    })
    expect(() => setLastCollection("ufc-strike")).not.toThrow()
  })
})

describe("active-collection (SSR / no window)", () => {
  it("getLastCollection returns the default with window undefined", () => {
    vi.stubGlobal("window", undefined)
    expect(getLastCollection()).toBe(DEFAULT)
  })

  it("setLastCollection is a no-op with window undefined", () => {
    vi.stubGlobal("window", undefined)
    expect(() => setLastCollection("laliga-golazos")).not.toThrow()
  })
})
