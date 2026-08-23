import { describe, it, expect } from "vitest"
import { classifySerial, hasQuirk, type SerialQuirk } from "@/lib/serials/fun-patterns"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// Quirky-serial classification: palindromes, repdigits, meme numbers, and
// matches against the player's jersey / birthday / draft year.
//
// The property that matters most is the one asserted last: these quirks must
// stay OUT of `specialSerialTraits`, which carries real FMV multipliers in
// lib/market-analytics.ts. A palindrome is a fun fact, not a measured premium.

const kinds = (q: SerialQuirk[]) => q.map((x) => x.kind)

describe("classifySerial — patterns needing no external data", () => {
  it("finds palindromes but not single digits", () => {
    expect(kinds(classifySerial(121))).toContain("palindrome")
    expect(kinds(classifySerial(1221))).toContain("palindrome")
    // A single digit is trivially a palindrome; reporting it is noise.
    expect(kinds(classifySerial(7))).not.toContain("palindrome")
  })

  it("reports a repdigit as a repdigit rather than a palindrome", () => {
    // 888 is both. "every digit is 8" is the stronger, more specific claim, and
    // reporting both would say the same thing twice.
    const q = kinds(classifySerial(888))
    expect(q).toContain("repdigit")
    expect(q).not.toContain("palindrome")
  })

  it("finds ascending and descending runs", () => {
    expect(kinds(classifySerial(123))).toContain("sequential")
    expect(kinds(classifySerial(4321))).toContain("sequential")
    expect(kinds(classifySerial(1245))).not.toContain("sequential")
  })

  it.each([
    [69, "69"],
    [420, "420"],
    [1337, "1337 (leet)"],
  ])("flags meme serial %i", (serial, label) => {
    const q = classifySerial(serial)
    expect(q.some((x) => x.kind === "meme" && x.label === label)).toBe(true)
  })

  it("flags round numbers, and only at 3+ digits", () => {
    expect(kinds(classifySerial(1000))).toContain("round")
    expect(kinds(classifySerial(50))).not.toContain("round")
  })

  it("returns an empty array for an ordinary serial — that is an answer, not a failure", () => {
    expect(classifySerial(4817)).toEqual([])
    expect(hasQuirk(4817)).toBe(false)
  })

  it.each([[null], [undefined], [0], [-5], [1.5], [NaN]])("returns nothing for invalid serial %s", (s) => {
    expect(classifySerial(s as number)).toEqual([])
  })
})

describe("classifySerial — first and last mint", () => {
  it("flags #1", () => {
    expect(kinds(classifySerial(1))).toContain("first_serial")
  })

  it("flags the final serial only when circulation is known", () => {
    expect(kinds(classifySerial(500, { circulationCount: 500 }))).toContain("last_serial")
    // Without circulation there is no way to know, so it must not guess.
    expect(kinds(classifySerial(500))).not.toContain("last_serial")
  })

  it("does not call serial 1 the last mint of a 1-of-1", () => {
    // circulation 1 means #1 is both first and last; reporting "last mint" adds
    // nothing and reads oddly next to "#1".
    const q = kinds(classifySerial(1, { circulationCount: 1 }))
    expect(q).toContain("first_serial")
    expect(q).not.toContain("last_serial")
  })
})

describe("classifySerial — context-dependent matches", () => {
  it("matches a jersey number, comparing numerically", () => {
    expect(kinds(classifySerial(5, { jerseyNumber: 5 }))).toContain("jersey_match")
    // Top Shot returns jerseyNumber as a STRING ("5"), and has returned
    // zero-padded values; both must agree with the numeric serial.
    expect(kinds(classifySerial(5, { jerseyNumber: "05" }))).toContain("jersey_match")
    expect(kinds(classifySerial(6, { jerseyNumber: "5" }))).not.toContain("jersey_match")
  })

  it("matches a birthday in MM/DD and states which reading it used", () => {
    // Immanuel Quickley, birthdate 1999-06-17 (a real probe sample).
    const q = classifySerial(617, { birthdate: "1999-06-17" })
    const hit = q.find((x) => x.kind === "birthday_match")
    expect(hit).toBeTruthy()
    // The reading must be spelled out — "matches their birthday" is
    // unverifiable on its face, and MM/DD vs DD/MM are different claims.
    expect(hit!.why).toContain("MM/DD")
    expect(hit!.why).toContain("1999-06-17")
  })

  it("matches the DD/MM reading too, and labels it as such", () => {
    const hit = classifySerial(1706, { birthdate: "1999-06-17" }).find((x) => x.kind === "birthday_match")
    expect(hit).toBeTruthy()
    expect(hit!.why).toContain("DD/MM")
  })

  it("does not claim a birthday match on an unrelated serial or a bad date", () => {
    expect(kinds(classifySerial(999, { birthdate: "1999-06-17" }))).not.toContain("birthday_match")
    expect(kinds(classifySerial(617, { birthdate: "not-a-date" }))).not.toContain("birthday_match")
    expect(kinds(classifySerial(617, { birthdate: null }))).not.toContain("birthday_match")
  })

  it("matches a draft year", () => {
    expect(kinds(classifySerial(2020, { draftYear: 2020 }))).toContain("draft_year_match")
    expect(kinds(classifySerial(2019, { draftYear: 2020 }))).not.toContain("draft_year_match")
  })

  it("matches a caller-supplied area code, and never invents one", () => {
    expect(kinds(classifySerial(503, { areaCodes: [503, 971] }))).toContain("area_code_match")
    expect(kinds(classifySerial(503, { areaCodes: [212] }))).not.toContain("area_code_match")
    // No map is baked in, so with no codes supplied there is no claim to make.
    expect(kinds(classifySerial(503))).not.toContain("area_code_match")
  })
})

describe("classifySerial — combinations and explanations", () => {
  it("reports every applicable quirk", () => {
    // 1221 is a palindrome; with circulation 1221 it is also the last mint.
    const q = kinds(classifySerial(1221, { circulationCount: 1221 }))
    expect(q).toContain("palindrome")
    expect(q).toContain("last_serial")
  })

  it("gives every quirk a non-empty explanation", () => {
    const q = classifySerial(617, { birthdate: "1999-06-17", jerseyNumber: 617, circulationCount: 617 })
    expect(q.length).toBeGreaterThan(1)
    for (const x of q) {
      expect(x.why, `${x.kind} must explain itself`).toBeTruthy()
      expect(x.label).toBeTruthy()
    }
  })
})

// ⚠ The honesty boundary, asserted as a source guard because no type enforces
// it. `specialSerialTraits` feeds applySerialPremium, where "#1 Serial"
// multiplies FMV by 1.35 and "Jersey Match" by 1.2. Those encode observed
// market premium; a palindrome does not. Wiring these quirks into that array
// would move FMV for thousands of moments on the strength of a joke.
describe("source guard — quirks must not leak into the FMV premium path", () => {
  it("market-analytics does not import the quirk classifier", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("lib/market-analytics.ts", "utf8")
    expect(src).not.toContain("fun-patterns")
    expect(src).not.toContain("classifySerial")
  })

  it("the quirk module claims no premium of its own", async () => {
    const { readFileSync } = await import("node:fs")
    const src = stripComments(readFileSync("lib/serials/fun-patterns.ts", "utf8"))
    // Comments stripped first: this file EXPLAINS the multipliers it must not
    // apply, and an unstripped search reads its own rationale as a violation.
    expect(src).not.toMatch(/multiplier|premium|\*=\s*1\./)
  })
})
