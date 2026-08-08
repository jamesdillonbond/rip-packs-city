import { describe, it, expect } from "vitest"
import {
  NOTABLE_TAG_TO_BADGE_TYPE,
  mapNotableTagsToSpecialSerials,
} from "@/lib/moment-special-serials"

describe("NOTABLE_TAG_TO_BADGE_TYPE", () => {
  it("is a strict 3-entry allowlist mapping to the legacy vocabulary", () => {
    expect(NOTABLE_TAG_TO_BADGE_TYPE).toEqual({
      "#1": "first_serial",
      jersey: "jersey_match",
      last_mint: "perfect_mint",
    })
  })
})

describe("mapNotableTagsToSpecialSerials", () => {
  it("keeps only the current serial and remaps its tag to a badge_type", () => {
    const rows = [
      { serial: 1, tag: "#1" },
      { serial: 2, tag: "jersey" },
      { serial: 1, tag: "last_mint" },
    ]
    expect(mapNotableTagsToSpecialSerials(rows, 1)).toEqual([
      { badge_type: "first_serial", serial_number: 1 },
      { badge_type: "perfect_mint", serial_number: 1 },
    ])
  })
  it("maps the jersey tag for a matching serial", () => {
    expect(mapNotableTagsToSpecialSerials([{ serial: 23, tag: "jersey" }], 23)).toEqual([
      { badge_type: "jersey_match", serial_number: 23 },
    ])
  })
  it("drops rows whose tag is not in the allowlist (no fabricated badge)", () => {
    const rows = [
      { serial: 5, tag: "mvp" },
      { serial: 5, tag: null },
      { serial: 5, tag: "" },
    ]
    expect(mapNotableTagsToSpecialSerials(rows, 5)).toEqual([])
  })
  it("drops rows whose tag is a prototype-name key (allowlist stays strict)", () => {
    // A crafted tag must not resolve an Object.prototype member (truthy) and
    // slip past the drop-guard, fabricating a badge whose badge_type is a fn.
    const rows = [
      { serial: 5, tag: "constructor" },
      { serial: 5, tag: "toString" },
      { serial: 5, tag: "valueOf" },
      { serial: 5, tag: "hasOwnProperty" },
    ]
    expect(mapNotableTagsToSpecialSerials(rows, 5)).toEqual([])
  })
  it("drops rows whose serial does not match", () => {
    expect(mapNotableTagsToSpecialSerials([{ serial: 9, tag: "#1" }], 5)).toEqual([])
  })
  it("returns [] for an empty input", () => {
    expect(mapNotableTagsToSpecialSerials([], 1)).toEqual([])
  })
})
