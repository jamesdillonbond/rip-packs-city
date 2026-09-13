import { describe, it, expect } from "vitest"
import { summariseProbeCost } from "@/lib/sentinel/probe-cost"

// The arm that would have caught the 2026-09-13 finding on a schedule: two
// sentinel probes costing ~72k and ~467k buffers per sweep on the instance's
// hottest table, reporting INCONCLUSIVE on the saturation they were feeding.

const row = (fn: string, blks: number, mean = 500, calls = 300) => ({
  fn,
  calls,
  mean_ms: mean,
  max_ms: mean * 4,
  blks_per_call: blks,
  total_s: Math.round((calls * mean) / 1000),
})
const payload = (rows: unknown[], since = "2026-08-12T01:33:59Z") => ({ since, rows })

describe("summariseProbeCost — the sentinel watches its own weight", () => {
  it("an unreadable payload is UNMEASURED, never clean", () => {
    for (const bad of [null, undefined, "nope" as any, 7 as any]) {
      const v = summariseProbeCost(bad)
      expect(v.status).toBe("warn")
      expect(v.detail).toMatch(/UNMEASURED/)
    }
  })

  it("⚠ an EMPTY list is a broken reader, not a free sentinel", () => {
    const v = summariseProbeCost(payload([]))
    expect(v.status).toBe("warn")
    expect(v.detail).toMatch(/ZERO ops RPCs/)
  })

  it("is ok when every probe is under both thresholds, naming the heaviest and the stats epoch", () => {
    const v = summariseProbeCost(payload([row("sentinel_sales_ingest_health", 5_694, 3_362), row("check_wall_kills", 33_000, 2_000), row("detect_stalled_pipelines", 200)]))
    expect(v.status).toBe("ok")
    expect(v.detail).toContain("3 ops RPCs since 2026-08-12")
    expect(v.detail).toContain("heaviest check_wall_kills at 33,000 buffers/call")
    expect(v.value).toBe(33_000)
  })

  it("warns on the class that was found: buffers per call over the line", () => {
    const v = summariseProbeCost(payload([row("sentinel_fmv_confidence_canonical_ts_split", 467_237, 6_316, 232), row("sentinel_edition_coverage", 71_783, 6_532, 320), row("check_anon_write_surface", 8_847)]))
    expect(v.status).toBe("warn")
    expect(v.detail).toContain("2 ops probe(s) ARE THEMSELVES LOAD")
    // Heaviest first.
    expect(v.detail.indexOf("sentinel_fmv_confidence_canonical_ts_split")).toBeLessThan(v.detail.indexOf("sentinel_edition_coverage"))
    expect(v.detail).toContain("467,237 buffers/call, mean 6,316 ms over 232 calls")
    expect(v.detail).not.toMatch(/check_anon_write_surface \d/)
    // The remedy travels with the finding, and it is not "raise the threshold".
    expect(v.detail).toMatch(/do not raise this threshold/)
  })

  it("warns on a cheap-in-buffers probe that is slow (waiting on locks)", () => {
    const v = summariseProbeCost(payload([row("check_slow", 900, 9_000)]))
    expect(v.status).toBe("warn")
    expect(v.detail).toContain("check_slow")
  })

  it("honours configured thresholds", () => {
    const rows = [row("a", 30_000, 1_000)]
    expect(summariseProbeCost(payload(rows), 50_000, 5_000).status).toBe("ok")
    expect(summariseProbeCost(payload(rows), 25_000, 5_000).status).toBe("warn")
    expect(summariseProbeCost(payload(rows), 50_000, 900).status).toBe("warn")
  })

  it("never pages", () => {
    const v = summariseProbeCost(payload(Array.from({ length: 9 }, (_, i) => row(`p${i}`, 999_999))))
    expect(v.status).toBe("warn")
    expect(v.detail).toContain("+4 more")
  })
})
