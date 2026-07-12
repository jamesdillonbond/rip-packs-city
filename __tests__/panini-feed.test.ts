import { describe, it, expect, vi } from "vitest"

// lib/chains/panini/feed.ts — Panini Blockchain Plane-A read client. The feed
// mode + creds are read from env at MODULE LOAD, so each scenario re-imports
// the module with vi.resetModules() after setting env. We test the pure config
// gate (paniniFeedEnabled / paniniFeedMode) and that fetchPaniniEditions is a
// clean no-op ([]) in every configuration (all branches are TODO stubs today,
// so it never actually fetches).

type Feed = typeof import("@/lib/chains/panini/feed")

async function load(env: {
  mode?: string
  cryptoKey?: string
  proxyUrl?: string
  proxySecret?: string
}): Promise<Feed> {
  vi.resetModules()
  process.env.PANINI_FEED_MODE = env.mode ?? ""
  process.env.CRYPTOSLAM_API_KEY = env.cryptoKey ?? ""
  process.env.PANINI_PROXY_URL = env.proxyUrl ?? ""
  process.env.PANINI_PROXY_SECRET = env.proxySecret ?? ""
  return import("@/lib/chains/panini/feed")
}

describe("paniniFeedMode", () => {
  it("returns '' when PANINI_FEED_MODE is unset", async () => {
    const feed = await load({})
    expect(feed.paniniFeedMode()).toBe("")
  })

  it("echoes the configured mode verbatim (even unknown values)", async () => {
    const feed = await load({ mode: "cryptoslam" })
    expect(feed.paniniFeedMode()).toBe("cryptoslam")
    const feed2 = await load({ mode: "onepanini" })
    expect(feed2.paniniFeedMode()).toBe("onepanini")
  })
})

describe("paniniFeedEnabled", () => {
  it("is false with no mode (INERT default)", async () => {
    const feed = await load({})
    expect(feed.paniniFeedEnabled()).toBe(false)
  })

  it("cryptoslam requires CRYPTOSLAM_API_KEY", async () => {
    expect((await load({ mode: "cryptoslam" })).paniniFeedEnabled()).toBe(false)
    expect(
      (await load({ mode: "cryptoslam", cryptoKey: "k" })).paniniFeedEnabled(),
    ).toBe(true)
  })

  it("onepanini requires BOTH proxy url and secret", async () => {
    expect((await load({ mode: "onepanini" })).paniniFeedEnabled()).toBe(false)
    expect(
      (await load({ mode: "onepanini", proxyUrl: "https://p" })).paniniFeedEnabled(),
    ).toBe(false)
    expect(
      (await load({ mode: "onepanini", proxySecret: "s" })).paniniFeedEnabled(),
    ).toBe(false)
    expect(
      (
        await load({ mode: "onepanini", proxyUrl: "https://p", proxySecret: "s" })
      ).paniniFeedEnabled(),
    ).toBe(true)
  })

  it("is false for an unrecognized mode", async () => {
    const feed = await load({ mode: "bogus" })
    expect(feed.paniniFeedEnabled()).toBe(false)
  })
})

describe("fetchPaniniEditions", () => {
  it("returns [] when inert (no mode)", async () => {
    const feed = await load({})
    await expect(feed.fetchPaniniEditions()).resolves.toEqual([])
  })

  it("returns [] for configured-but-TODO cryptoslam", async () => {
    const feed = await load({ mode: "cryptoslam", cryptoKey: "k" })
    await expect(feed.fetchPaniniEditions()).resolves.toEqual([])
  })

  it("returns [] for configured-but-TODO onepanini", async () => {
    const feed = await load({
      mode: "onepanini",
      proxyUrl: "https://p",
      proxySecret: "s",
    })
    await expect(feed.fetchPaniniEditions()).resolves.toEqual([])
  })
})
