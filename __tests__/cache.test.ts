import { describe, it, expect } from "vitest"
import {
  getCache,
  setCache,
  getOrSetCache,
  deleteCache,
  clearCacheByPrefix,
} from "@/lib/cache"

// In-process TTL cache with single-flight getOrSetCache (dedupes concurrent
// factory calls for the same key). Unique keys per test avoid cross-test bleed
// through the module-global map.

describe("getCache / setCache", () => {
  it("stores and retrieves within TTL", () => {
    setCache("t:a", 42, 10_000)
    expect(getCache<number>("t:a")).toBe(42)
  })

  it("returns null for a missing key", () => {
    expect(getCache("t:missing")).toBeNull()
  })

  it("treats an already-past TTL as expired", () => {
    setCache("t:exp", "x", -1)
    expect(getCache("t:exp")).toBeNull()
  })
})

describe("getOrSetCache", () => {
  it("calls the factory once, then serves cached", async () => {
    let calls = 0
    const factory = async () => {
      calls++
      return "v"
    }
    expect(await getOrSetCache("t:g1", 10_000, factory)).toBe("v")
    expect(await getOrSetCache("t:g1", 10_000, factory)).toBe("v")
    expect(calls).toBe(1)
  })

  it("single-flights concurrent calls for the same key", async () => {
    let calls = 0
    const factory = () =>
      new Promise<string>((resolve) => {
        calls++
        setTimeout(() => resolve("shared"), 5)
      })
    const [a, b] = await Promise.all([
      getOrSetCache("t:g2", 10_000, factory),
      getOrSetCache("t:g2", 10_000, factory),
    ])
    expect(a).toBe("shared")
    expect(b).toBe("shared")
    expect(calls).toBe(1)
  })

  it("does not cache a rejected factory (next call retries)", async () => {
    let calls = 0
    const factory = async () => {
      calls++
      throw new Error("boom")
    }
    await expect(getOrSetCache("t:g3", 10_000, factory)).rejects.toThrow("boom")
    await expect(getOrSetCache("t:g3", 10_000, factory)).rejects.toThrow("boom")
    expect(calls).toBe(2)
  })
})

describe("deleteCache / clearCacheByPrefix", () => {
  it("deleteCache removes a single key", () => {
    setCache("t:d", 1, 10_000)
    deleteCache("t:d")
    expect(getCache("t:d")).toBeNull()
  })

  it("clearCacheByPrefix removes all keys under a prefix", () => {
    setCache("pfx:1", 1, 10_000)
    setCache("pfx:2", 2, 10_000)
    setCache("other:1", 3, 10_000)
    clearCacheByPrefix("pfx:")
    expect(getCache("pfx:1")).toBeNull()
    expect(getCache("pfx:2")).toBeNull()
    expect(getCache("other:1")).toBe(3)
  })
})
