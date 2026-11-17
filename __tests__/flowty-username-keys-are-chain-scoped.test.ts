import { describe, it, expect } from "vitest"

import {
  nameKey,
  truncateAddress as truncateAddressServer,
  displayName as displayNameServer,
} from "@/lib/flowty-username"
import {
  truncateAddress as truncateAddressClient,
  displayName as displayNameClient,
} from "@/lib/analytics/username-resolver"

// ⛔ THE DEFECT THIS PINS WAS CAUGHT IN PRODUCTION, not in review.
//
// `displayName()` folded its argument to lower case and then handed the FOLDED
// string to `truncateAddress()` as the fallback. On Flow that is harmless —
// hex is case-insensitive. On Solana it destroys the address, and because the
// value is RENDERED as the wallet's identity the result is a fabrication, not
// an absence. Measured live 2026-09-20 on
// /api/public/insights/top-sales?collection=candy_mlb:
//
//   buyer_address  1Ttv9XYVPgHRJQwBX2Ccn5GUcgM5BsAWX13kH4gZEQV
//   buyer_name     1ttv9xyvpghrjqwbx2ccn5gucgm5bsawx13kh4gzeqv   ← rendered
//
// Two copy-paste twins carried it (server + client), so both are pinned here in
// one file: fixing the one that showed the symptom and leaving the other is how
// this class keeps coming back.
//
// ⚠ Every Solana assertion is paired with a HEX NO-CHANGE ARM asserting the
// exact byte-for-byte output the folding version produced. Widening for a new
// chain must never narrow the incumbent one, and without that arm a Solana fix
// that also changed every Flow label would pass this file.

const SOL = "1Ttv9XYVPgHRJQwBX2Ccn5GUcgM5BsAWX13kH4gZEQV"
const SOL_2 = "F6JUS3iGnAZee15MpFVDafv5GHopqKBhogncjrxhkTE7"
const FLOW = "0xA4FB6E11E026C8ED"
const FLOW_LOWER = "0xa4fb6e11e026c8ed"

describe("nameKey — the map key is chain-scoped", () => {
  it("keeps base58 case EXACTLY, because the key is the address", () => {
    expect(nameKey(SOL)).toBe(SOL)
    expect(nameKey(SOL_2)).toBe(SOL_2)
  })

  it("still folds hex — the incumbent no-change arm", () => {
    expect(nameKey(FLOW)).toBe(FLOW_LOWER)
    expect(nameKey(FLOW_LOWER)).toBe(FLOW_LOWER)
  })

  it("survives null/undefined/empty without throwing", () => {
    expect(nameKey(null)).toBe("")
    expect(nameKey(undefined)).toBe("")
    expect(nameKey("")).toBe("")
  })
})

// Run the identical battery against both twins so neither can drift alone.
const IMPLS: Array<{
  label: string
  truncate: (a: string) => string
  display: (a: string, names: any) => string
  empty: () => any
  withName: (key: string, name: string) => any
}> = [
  {
    label: "server (lib/flowty-username)",
    truncate: truncateAddressServer,
    display: displayNameServer as (a: string, n: any) => string,
    empty: () => new Map<string, string>(),
    withName: (key, name) => new Map<string, string>([[key, name]]),
  },
  {
    label: "client (lib/analytics/username-resolver)",
    truncate: truncateAddressClient,
    display: displayNameClient as (a: string, n: any) => string,
    empty: () => ({}),
    withName: (key, name) => ({ [key]: name }),
  },
]

for (const impl of IMPLS) {
  describe(`${impl.label} — a displayed address is never case-folded`, () => {
    it("truncates base58 with its case intact", () => {
      // The ASSERTION IS THE ABSENCE OF THE FALSE CLAIM: the rendered string
      // must not be the lower-cased address, which is what shipped.
      const out = impl.truncate(SOL)
      expect(out).toBe("1Ttv9X…ZEQV")
      expect(out).not.toBe(SOL.toLowerCase().slice(0, 6) + "…" + SOL.toLowerCase().slice(-4))
      expect(out.toLowerCase()).not.toBe(out)
    })

    it("hex no-change arm: still folds and still truncates exactly as before", () => {
      expect(impl.truncate(FLOW)).toBe("0xa4fb…c8ed")
      expect(impl.truncate(FLOW_LOWER)).toBe("0xa4fb…c8ed")
    })

    it("displayName falls back to the ORIGINAL address, not the folded key", () => {
      expect(impl.display(SOL, impl.empty())).toBe("1Ttv9X…ZEQV")
      expect(impl.display(SOL_2, impl.empty())).toBe("F6JUS3…kTE7")
    })

    it("displayName resolves a base58 key stored with its real case", () => {
      expect(impl.display(SOL, impl.withName(SOL, "candy-whale"))).toBe("candy-whale")
    })

    it("hex no-change arm: displayName still resolves a folded hex key", () => {
      expect(impl.display(FLOW, impl.withName(FLOW_LOWER, "flow-whale"))).toBe("flow-whale")
      expect(impl.display(FLOW, impl.empty())).toBe("0xa4fb…c8ed")
    })
  })
}

describe("the two twins agree", () => {
  it("produce identical output for every address in the battery", () => {
    for (const addr of [SOL, SOL_2, FLOW, FLOW_LOWER, "", "not-an-address"]) {
      expect(truncateAddressClient(addr)).toBe(truncateAddressServer(addr))
    }
  })
})
