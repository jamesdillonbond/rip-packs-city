import { describe, it, expect } from "vitest"
import { summarisePgNet } from "@/lib/sentinel/pg-net"

// pg_net is the dispatcher under every edge-function and Atlas lane, and its
// response store is the largest relation on the instance (register #75).
// Nothing watched either until 2026-09-13.

const healthy = (over: Record<string, unknown> = {}) => ({
  queued: 0,
  responses_10m: 139,
  errored_10m: 3,
  http5xx_10m: 0,
  last_response_at: "2026-09-13T17:32:15Z",
  store_bytes: 1.4 * 1024 ** 3,
  store_rows: 5391,
  ttl: "6 hours",
  batch_size: 200,
  ...over,
})

describe("summarisePgNet — the dispatcher and its store", () => {
  it("an unreadable payload is UNMEASURED, never clean", () => {
    for (const bad of [null, undefined, "nope" as any, 7 as any]) {
      const v = summarisePgNet(bad)
      expect(v.status).toBe("warn")
      expect(v.detail).toMatch(/UNMEASURED/)
    }
  })

  it("⚠ a missing queue or response count is not a zero", () => {
    expect(summarisePgNet(healthy({ queued: null })).status).toBe("warn")
    expect(summarisePgNet(healthy({ responses_10m: undefined })).detail).toMatch(/UNMEASURED/)
  })

  it("is ok when the queue is empty, responses land, and the store is small — and names the scope", () => {
    const v = summarisePgNet(healthy())
    expect(v.status).toBe("ok")
    expect(v.detail).toContain("queue 0, 139 responses/10m (3 errored, 0 5xx)")
    expect(v.detail).toContain("store 1.4 GB")
    expect(v.value).toBe(0)
  })

  it("warns on a backed-up queue (one batch or more)", () => {
    const v = summarisePgNet(healthy({ queued: 250 }))
    expect(v.status).toBe("warn")
    expect(v.detail).toContain("250 requests QUEUED")
  })

  it("warns on a STALLED worker: something queued and nothing landed in 10 min", () => {
    const v = summarisePgNet(healthy({ queued: 3, responses_10m: 0, errored_10m: 0 }))
    expect(v.status).toBe("warn")
    expect(v.detail).toMatch(/STALLED/)
    // A quiet 10 minutes with NOTHING queued is not a stall — nothing was asked.
    expect(summarisePgNet(healthy({ queued: 0, responses_10m: 0, errored_10m: 0 })).status).toBe("ok")
  })

  it("warns on an error share ≥ 25% over a real sample, not over a handful", () => {
    expect(summarisePgNet(healthy({ responses_10m: 40, errored_10m: 12 })).status).toBe("warn")
    expect(summarisePgNet(healthy({ responses_10m: 4, errored_10m: 2 })).status).toBe("ok")
  })

  it("warns on the store size the register carries as #75, naming the lever and whose call it is", () => {
    const v = summarisePgNet(healthy({ store_bytes: 13 * 1024 ** 3 }))
    expect(v.status).toBe("warn")
    expect(v.detail).toContain("response store is 13.0 GB")
    expect(v.detail).toMatch(/#75/)
    expect(v.detail).toMatch(/VACUUM FULL/)
  })

  it("honours configured thresholds", () => {
    expect(summarisePgNet(healthy({ store_bytes: 3 * 1024 ** 3 }), 2 * 1024 ** 3).status).toBe("warn")
    expect(summarisePgNet(healthy({ queued: 50 }), undefined, 40).status).toBe("warn")
  })

  it("never pages", () => {
    const v = summarisePgNet(healthy({ queued: 9999, responses_10m: 0, store_bytes: 99 * 1024 ** 3 }))
    expect(v.status).toBe("warn")
  })
})
