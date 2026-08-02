// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest"
import { safeLoadJson, safeSaveJson, safeLoadString, safeSaveString } from "@/lib/local-storage"
import {
  getTrackedCollections,
  setTrackedCollections,
  addTrackedCollection,
  removeTrackedCollection,
} from "@/lib/tracked-collections"
import { getLastCollection, setLastCollection } from "@/lib/active-collection"

// localStorage-backed client state. Runs under jsdom (the default node env has
// no window/localStorage). Pin round-trips, defaults, and corruption tolerance.

beforeEach(() => localStorage.clear())

describe("local-storage safe JSON/string", () => {
  it("round-trips JSON and returns fallback when absent", () => {
    expect(safeLoadJson("k", { a: 1 })).toEqual({ a: 1 }) // fallback
    safeSaveJson("k", { a: 2, b: [3] })
    expect(safeLoadJson("k", { a: 1 })).toEqual({ a: 2, b: [3] })
  })

  it("returns the fallback on corrupt JSON rather than throwing", () => {
    localStorage.setItem("bad", "{not json")
    expect(safeLoadJson("bad", "fb")).toBe("fb")
  })

  it("round-trips strings", () => {
    expect(safeLoadString("s", "def")).toBe("def")
    safeSaveString("s", "hello")
    expect(safeLoadString("s")).toBe("hello")
  })
})

describe("tracked-collections", () => {
  it("defaults to [nba-top-shot] and persists a set", () => {
    expect(getTrackedCollections()).toEqual(["nba-top-shot"])
    setTrackedCollections(["nfl-all-day", "ufc"])
    expect(getTrackedCollections()).toEqual(["nfl-all-day", "ufc"])
  })

  it("add is idempotent; remove filters", () => {
    setTrackedCollections(["nba-top-shot"])
    addTrackedCollection("ufc")
    addTrackedCollection("ufc") // no dupe
    expect(getTrackedCollections()).toEqual(["nba-top-shot", "ufc"])
    removeTrackedCollection("nba-top-shot")
    expect(getTrackedCollections()).toEqual(["ufc"])
  })

  it("falls back to default when the stored value is not an array", () => {
    localStorage.setItem("rpc_tracked_collections", JSON.stringify({ not: "array" }))
    expect(getTrackedCollections()).toEqual(["nba-top-shot"])
  })
})

describe("active-collection", () => {
  it("defaults to nba-top-shot and persists the last collection", () => {
    expect(getLastCollection()).toBe("nba-top-shot")
    setLastCollection("laliga-golazos")
    expect(getLastCollection()).toBe("laliga-golazos")
  })
})
