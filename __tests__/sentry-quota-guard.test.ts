import { describe, it, expect } from "vitest"
import {
  classify,
  eventText,
  makeBeforeSend,
  KNOWN_HIGH_VOLUME,
  type MinimalSentryEvent,
} from "../lib/observability/sentry-quota-guard"

// ── WHY THIS GUARD EXISTS ──────────────────────────────────────────────────
// Measured 2026-08-25 (PT) by POSTing one envelope at the production DSN:
//
//   HTTP 429
//   x-sentry-rate-limits: 60:default;error;security;attachment:organization:error_usage_exceeded
//
// The org error quota is exhausted; Sentry's last accepted event is
// 2026-08-18T13:21:59Z. The burn is ONE already-tracked signature: the RPC
// deadline shape from lib/analytics/rpc-with-retry.ts, at 15,388 events in the
// 7 days to 2026-08-23 from the edition page alone.
//
// ── WHAT THIS FILE PINS, AND WHY EACH ASSERTION IS THE CONTRACT ─────────────
// The dangerous version of this module is one that quietly drops MORE than the
// listed signatures — that is the honesty canon ("a failed read must not render
// as an answer") applied to the error channel: a thinned stream reads as a
// quieter system. So the load-bearing assertion is the NEGATIVE one — that an
// unrecognised error is never dropped, at any random draw — not the positive
// one that a known signature is sampled.
//
// ⚠ Deliberately satisfiable at a population of ZERO: nothing here asserts that
// KNOWN_HIGH_VOLUME is non-empty. Emptying the list must not red this file —
// an empty list means "sample nothing", which is a safe state, and a guard that
// punishes its own success is this repo's named anti-pattern.

const RPC_DEADLINE = "rpc get_edition_detail timed out after 45000ms with no response"
const PAGE_WRAPPED = `edition detail unavailable: ${RPC_DEADLINE}`

function errEvent(value: string, type = "Error"): MinimalSentryEvent {
  return { exception: { values: [{ type, value }] } }
}

describe("sentry quota guard — the default is SEND", () => {
  it("never drops an unrecognised error, even on the draw that would drop a sampled one", () => {
    // random() = 0 is the draw that KEEPS a sampled event; 0.999 is the draw
    // that DROPS one. An unrecognised error must survive both, or the module has
    // a catch-all.
    for (const draw of [0, 0.5, 0.999999]) {
      const beforeSend = makeBeforeSend(() => draw)
      const ev = errEvent("Cannot read properties of undefined (reading 'id')")
      expect(beforeSend(ev)).not.toBeNull()
    }
  })

  it("does not sample an error that merely mentions a timeout", () => {
    // Negative control on the matcher: the property is the RPC-deadline SHAPE
    // produced by rpc-with-retry's timeoutError(), not the word "timeout".
    const beforeSend = makeBeforeSend(() => 0.999999)
    expect(classify(errEvent("fetch to upstream timed out"))).toBeNull()
    expect(beforeSend(errEvent("fetch to upstream timed out"))).not.toBeNull()
    expect(beforeSend(errEvent("TimeoutError: The operation was aborted due to timeout"))).not.toBeNull()
  })

  it("passes an event carrying no message and no exception straight through", () => {
    const beforeSend = makeBeforeSend(() => 0.999999)
    expect(beforeSend({} as MinimalSentryEvent)).not.toBeNull()
  })
})

describe("sentry quota guard — the RPC deadline signature", () => {
  it("classifies both the raw RPC message and the page-wrapped form", () => {
    // The page wrappers interpolate the same string, so the matcher must key on
    // the interpolated shape rather than on any one page's prefix.
    expect(classify(errEvent(RPC_DEADLINE))?.signature).toBe("rpc-deadline")
    expect(classify(errEvent(PAGE_WRAPPED))?.signature).toBe("rpc-deadline")
    expect(classify({ message: PAGE_WRAPPED })?.signature).toBe("rpc-deadline")
  })

  it("keeps it below its rate and drops it at or above", () => {
    const rule = KNOWN_HIGH_VOLUME.find((r) => r.signature === "rpc-deadline")
    expect(rule).toBeDefined()
    const rate = rule!.rate

    expect(makeBeforeSend(() => rate * 0.5)(errEvent(PAGE_WRAPPED))).not.toBeNull()
    expect(makeBeforeSend(() => rate)(errEvent(PAGE_WRAPPED))).toBeNull()
    expect(makeBeforeSend(() => 1)(errEvent(PAGE_WRAPPED))).toBeNull()
  })

  it("stamps the kept event with its own sample rate so the count is recoverable", () => {
    // This is the assertion that keeps the sampling HONEST. Without the rate on
    // the event, an issue's count silently understates incidence by 1/rate and
    // there is nothing in Sentry that says so.
    const rule = KNOWN_HIGH_VOLUME.find((r) => r.signature === "rpc-deadline")!
    const kept = makeBeforeSend(() => 0)(errEvent(PAGE_WRAPPED))
    expect(kept).not.toBeNull()
    expect(kept!.tags?.sentry_sampled_signature).toBe("rpc-deadline")
    expect(kept!.tags?.sentry_sample_rate).toBe(rule.rate)
  })

  it("preserves tags the SDK already set rather than replacing them", () => {
    const ev: MinimalSentryEvent = { ...errEvent(PAGE_WRAPPED), tags: { runtime: "nodejs" } }
    const kept = makeBeforeSend(() => 0)(ev)
    expect(kept!.tags?.runtime).toBe("nodejs")
  })
})

describe("sentry quota guard — every listed rule is a real bound", () => {
  it("has no rule with a rate of 1 (a no-op) or 0 (a silent total drop)", () => {
    // rate === 1 means the entry does nothing but read as protection.
    // rate === 0 means the signature disappears entirely with no surviving
    // sample — the shape this repo calls an unfalsifiable alert.
    for (const rule of KNOWN_HIGH_VOLUME) {
      expect(rule.rate).toBeGreaterThan(0)
      expect(rule.rate).toBeLessThan(1)
    }
  })

  it("flattens type and value into the matched text", () => {
    expect(eventText(errEvent("boom", "RangeError"))).toContain("RangeError")
    expect(eventText(errEvent("boom", "RangeError"))).toContain("boom")
  })
})
