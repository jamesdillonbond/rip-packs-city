import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  challengeIngestEnabled,
  fetchTopshotChallenges,
  ingestTopshotChallenges,
} from "@/lib/challenges/topshot-ingest"

// Top Shot challenge-definition ingest. TS_PROXY_SECRET is captured at module
// load (const … = process.env… || ""), so the statically-imported module always
// sees it empty and fetchTopshotChallenges throws the "not set" guard before any
// network call. To reach the second guard (CHALLENGE_QUERY still holds the
// __CONFIRM_ME__ placeholder) we reset modules with the secret set at import time.
//
// UNCOVERABLE without a production change: the confirmed-query happy path
// (gql() → node scan → mapChallenge) and ingestTopshotChallenges's upsert/skip
// loop are gated behind the __CONFIRM_ME__ throw, and the loop's internal call to
// fetchTopshotChallenges can't be intercepted (ESM binds it locally, not via the
// namespace). Both stay dormant until the query is filled in.

const origEnv = { ...process.env }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  process.env = { ...origEnv }
})

describe("challengeIngestEnabled", () => {
  it("true only when CHALLENGE_INGEST_ENABLED === 'true'", () => {
    process.env.CHALLENGE_INGEST_ENABLED = "true"
    expect(challengeIngestEnabled()).toBe(true)
    process.env.CHALLENGE_INGEST_ENABLED = "1"
    expect(challengeIngestEnabled()).toBe(false)
    delete process.env.CHALLENGE_INGEST_ENABLED
    expect(challengeIngestEnabled()).toBe(false)
  })
})

describe("fetchTopshotChallenges", () => {
  it("throws the 'TS_PROXY_SECRET not set' guard (empty at import) without fetching", async () => {
    const spy = vi.fn()
    vi.stubGlobal("fetch", spy)
    await expect(fetchTopshotChallenges()).rejects.toThrow(/TS_PROXY_SECRET not set/)
    expect(spy).not.toHaveBeenCalled()
  })

  it("reaches the unconfirmed-query guard when the secret is present at import time", async () => {
    vi.resetModules()
    process.env.TS_PROXY_SECRET = "proxy-secret"
    const spy = vi.fn()
    vi.stubGlobal("fetch", spy)
    const mod = await import("@/lib/challenges/topshot-ingest")
    await expect(mod.fetchTopshotChallenges()).rejects.toThrow(/CHALLENGE_QUERY not yet confirmed/)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe("ingestTopshotChallenges", () => {
  it("propagates the fetch guard throw and makes no RPC calls", async () => {
    const rpc = vi.fn()
    await expect(ingestTopshotChallenges({ rpc })).rejects.toThrow(/TS_PROXY_SECRET not set/)
    expect(rpc).not.toHaveBeenCalled()
  })

  it("propagates the confirmed-query guard when the secret is set at import", async () => {
    vi.resetModules()
    process.env.TS_PROXY_SECRET = "proxy-secret"
    const rpc = vi.fn()
    const mod = await import("@/lib/challenges/topshot-ingest")
    await expect(mod.ingestTopshotChallenges({ rpc })).rejects.toThrow(/CHALLENGE_QUERY not yet confirmed/)
    expect(rpc).not.toHaveBeenCalled()
  })
})
