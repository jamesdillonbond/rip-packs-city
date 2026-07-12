// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { vi } from "vitest"

// BadgePills sorts its (de-duplicated, truthy) titles ascending by taxonomy
// priority — unknown titles get +Infinity and sink to the tail rendering
// their raw input as the label — then optionally slices to `limit`. Empty =>
// renders nothing. We stub the taxonomy so priority/label/color are
// deterministic (the component only reads what lookupBadge returns).
const META: Record<string, any> = {
  Rookie: { title: "Rookie Mint", color_family: "gold", priority: 1, description: "First mint" },
  Debut: { title: "Top Shot Debut", color_family: "blue", priority: 5, description: null },
}
vi.mock("@/lib/badges/useBadgeTaxonomy", () => ({
  useBadgeTaxonomy: () => ({}),
  lookupBadge: (_map: unknown, input: string) => META[input] ?? null,
  classesForColorFamily: (fam: string | null | undefined) => (fam ? `cf-${fam}` : "cf-neutral"),
}))

import BadgePills from "@/components/BadgePills"

afterEach(cleanup)

function labels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("span")).map((s) => s.textContent!.trim())
}

describe("BadgePills", () => {
  it("renders nothing when there are no truthy titles", () => {
    expect(render(<BadgePills titles={[]} />).container.firstChild).toBeNull()
    cleanup()
    expect(render(<BadgePills titles={["", ""]} />).container.firstChild).toBeNull()
  })

  it("sorts by priority and sinks unknown titles (raw label) to the tail", () => {
    const { container } = render(<BadgePills titles={["Zzz", "Debut", "Rookie"]} />)
    // Rookie (1) → Debut (5) → Zzz (+Infinity, raw input as label)
    expect(labels(container)).toEqual(["Rookie Mint", "Top Shot Debut", "Zzz"])
  })

  it("de-duplicates titles and applies the limit after sorting", () => {
    const { container } = render(<BadgePills titles={["Debut", "Rookie", "Debut"]} limit={1} />)
    // Deduped -> [Debut, Rookie], sorted -> [Rookie, Debut], limit 1 -> [Rookie]
    expect(labels(container)).toEqual(["Rookie Mint"])
  })

  it("carries the description into the pill title and the color-family class", () => {
    const { container } = render(<BadgePills titles={["Rookie"]} />)
    const span = container.querySelector("span")!
    expect(span.getAttribute("title")).toBe("Rookie Mint — First mint")
    expect(span.className).toContain("cf-gold")
  })
})
