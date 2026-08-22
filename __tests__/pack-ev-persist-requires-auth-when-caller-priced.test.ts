import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { computeDualPrice, priceIsCallerInfluenced } from "@/lib/pack-ev-pricing"

// deep-audit R24 — R2's sibling; the R2 fix did not generalise.
//
// /api/pack-ev is open to ANONYMOUS POST in proxy.ts (the same "batch
// read-compute, no writes" block R2 lived in). Its handler is not write-free:
// requestedPrice comes from the request body, becomes dual.packPrice when the
// pack has primary supply and is for sale, and a SERVICE_ROLE client inserts it
// into pack_ev_history — driving pack_ev, value_ratio and is_positive_ev.
//
// ⚠ check_anon_write_surface() cannot see this: it tests the anon DB ROLE, and
// the route holds the service-role key.

describe("R24 — the caller-influenced-price predicate", () => {
  it("flags the two price sources the caller can set", () => {
    expect(priceIsCallerInfluenced("primary")).toBe(true)
    expect(priceIsCallerInfluenced("min")).toBe(true)
  })

  it("does NOT flag prices derived from data we hold", () => {
    // NO-CHANGE CONTROL. Over-flagging would silently stop legitimate anonymous
    // history writes for secondary-priced packs — a availability regression that
    // would look like nothing at all.
    expect(priceIsCallerInfluenced("secondary")).toBe(false)
    expect(priceIsCallerInfluenced("none")).toBe(false)
  })

  it("agrees with computeDualPrice: a caller price really does become packPrice", () => {
    // Pins the JOIN between the predicate and the function it describes. If
    // computeDualPrice's precedence changed so that a caller price reached
    // packPrice under some other priceSource, the predicate would be stale and
    // every test above would still pass.
    const d = computeDualPrice({ requestedPrice: 999.99, totalUnopened: 5, forSale: true, secondaryAsk: null })
    expect(d.priceSource).toBe("primary")
    expect(d.packPrice).toBe(999.99)
    expect(priceIsCallerInfluenced(d.priceSource)).toBe(true)

    // and the converse: no primary supply => the caller's number is discarded
    const s = computeDualPrice({ requestedPrice: 999.99, totalUnopened: 0, forSale: false, secondaryAsk: 12 })
    expect(s.priceSource).toBe("secondary")
    expect(s.packPrice).toBe(12)
    expect(priceIsCallerInfluenced(s.priceSource)).toBe(false)
  })

  it("a caller price BELOW a real secondary ask still wins, and is still flagged", () => {
    // The abuse shape: undercut the real ask to force a favourable EV denominator.
    const d = computeDualPrice({ requestedPrice: 1, totalUnopened: 5, forSale: true, secondaryAsk: 500 })
    expect(d.packPrice).toBe(1)
    expect(priceIsCallerInfluenced(d.priceSource)).toBe(true)
  })
})

describe("R24 — the route actually applies the gate", () => {
  const src = readFileSync("app/api/pack-ev/route.ts", "utf8")

  it("gates the pack_ev_history insert on authorisation when the price is caller-influenced", () => {
    expect(src).toContain("priceIsCallerInfluenced(dual.priceSource)")
    expect(src).toContain("callerInfluencedPrice && !persistAuthorized(req)")
  })

  it("fails CLOSED when neither secret is configured", () => {
    // The predicate must require a NON-EMPTY secret to match. `auth === ""` must
    // never authorise, or an unset env var opens the write path silently.
    const fn = src.slice(src.indexOf("function persistAuthorized"))
    expect(fn).toContain("!!cronSecret &&")
    expect(fn).toContain("!!ingest &&")
  })

  it("leaves the READ/compute path anonymous — this gates the WRITE only", () => {
    // The gate must sit inside the history-snapshot block, not around the
    // response. Anyone may still compute pack EV.
    const gateAt = src.indexOf("callerInfluencedPrice && !persistAuthorized(req)")
    const insertAt = src.indexOf('from("pack_ev_history").insert(')
    expect(gateAt).toBeGreaterThan(0)
    expect(insertAt).toBeGreaterThan(gateAt)
  })
})
