// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

vi.mock("@/components/SpecialSerialGlyph", () => ({
  default: ({ tag }: { tag: string }) => <i data-testid="glyph" data-tag={tag} />,
}))

import SerialBadge from "@/components/collection/SerialBadge"

// The binder's serial pills (components/collection/SerialBadge) must follow the
// canonical specialCats() rule in lib/badges/glyphs.ts. 2026-10-10: a Donovan
// Clingan #1/1 drew "#1" AND "PM" because this component tested
// `serial === mintSize` without the `circ > 1` guard. A 1-of-1 is a #1, not
// also a perfect mint.

afterEach(cleanup)
const labels = (c: HTMLElement) => Array.from(c.querySelectorAll("span[title]")).map((e) => e.textContent)

describe("collection SerialBadge", () => {
  it("a 1-of-1 shows #1 and NOT Perfect Mint", () => {
    const { container } = render(<SerialBadge serial={1} mintSize={1} jerseyNumber={23} />)
    expect(labels(container)).toEqual(["#1"])
  })

  it("the last serial of a real edition is a Perfect Mint", () => {
    const { container } = render(<SerialBadge serial={99} mintSize={99} jerseyNumber={null} />)
    expect(labels(container)).toEqual(["PM"])
  })

  it("jersey 0 (no number on file) is never a jersey match", () => {
    const { container } = render(<SerialBadge serial={1} mintSize={50} jerseyNumber={0} />)
    expect(labels(container)).toEqual(["#1"])
  })

  it("#1 that is also the jersey number shows both", () => {
    const { container } = render(<SerialBadge serial={1} mintSize={50} jerseyNumber={1} />)
    expect(labels(container)).toEqual(["#1", "JM"])
  })
})
