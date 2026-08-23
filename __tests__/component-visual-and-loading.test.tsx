// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { readFileSync } from "node:fs"
import path from "node:path"
import LoadingState from "@/components/ui/LoadingState"
import PinwheelDivider from "@/components/visual/PinwheelDivider"
import ConsoleGreeting from "@/components/visual/ConsoleGreeting"

// `components/ui/` and `components/visual/` matched no glob in the component
// gate's curated `include`. Small files, but `LoadingState` is the skeleton
// every `loading.tsx` on the entity surface renders, and `ConsoleGreeting` holds
// the ONE sanctioned hardcode of the brand red in the whole repo — the kind of
// exception that quietly becomes a precedent when nothing pins why it exists.

afterEach(cleanup)

const read = (...p: string[]) => readFileSync(path.resolve(__dirname, "..", ...p), "utf8")

describe("LoadingState", () => {
  it("renders the requested number of skeleton bars", () => {
    render(<LoadingState lines={7} />)
    expect(document.querySelectorAll(".rpc-skeleton").length).toBe(7)
  })

  it("defaults to five rather than to zero", () => {
    // A default that fell through to `undefined` would make `Array.from({length:
    // undefined})` an empty array — a "loading" state that renders nothing but
    // the caption, which reads as an empty page rather than a pending one.
    render(<LoadingState />)
    expect(document.querySelectorAll(".rpc-skeleton").length).toBe(5)
  })

  it("says it is SCANNING, never that there is nothing here", () => {
    // ⚠ The honesty property. This is a pending state, not an empty one; the
    // copy must not conclude anything about the market. `loading.tsx` renders
    // it while the real read is still in flight.
    render(<LoadingState />)

    const text = document.body.textContent ?? ""
    expect(text).toMatch(/SCANNING THE MARKETPLACE/)
    expect(text).not.toMatch(/no results|nothing|empty|not found/i)
  })

  it("cycles the bar widths instead of running off the end of the array", () => {
    // The width table holds 10 entries and the index is modulo'd. Ask for more
    // than 10 and a dropped `% widths.length` yields `width: undefined%`.
    render(<LoadingState lines={14} />)

    const widths = Array.from(document.querySelectorAll<HTMLElement>(".rpc-skeleton")).map(
      (el) => el.style.width,
    )
    expect(widths.length).toBe(14)
    for (const w of widths) expect(w).toMatch(/^\d+%$/)
    expect(widths[0]).toBe(widths[10])
  })

  it("renders nothing but the caption at lines={0} — and does not throw", () => {
    render(<LoadingState lines={0} />)
    expect(document.querySelectorAll(".rpc-skeleton").length).toBe(0)
    expect(screen.getByText(/SCANNING THE MARKETPLACE/)).toBeTruthy()
  })
})

describe("PinwheelDivider", () => {
  it("is decorative and hidden from assistive tech", () => {
    const { container } = render(<PinwheelDivider />)
    expect(container.querySelector("[aria-hidden]")).not.toBeNull()
  })

  it("tiles one pinwheel per unit of density and sizes the viewBox to match", () => {
    render(<PinwheelDivider density={5} />)

    const svg = document.querySelector("svg")
    expect(svg?.getAttribute("viewBox")).toBe("0 0 300 80") // 5 tiles * 60px
    expect(svg?.querySelectorAll("g").length).toBe(5)
  })

  it("defaults to a density that actually draws something", () => {
    render(<PinwheelDivider />)
    expect(document.querySelectorAll("svg g").length).toBe(8)
  })

  it("draws four blades and a hub per tile", () => {
    render(<PinwheelDivider density={2} />)
    expect(document.querySelectorAll("svg path").length).toBe(8)
    expect(document.querySelectorAll("svg circle").length).toBe(2)
  })

  it("takes its colour from the border token, never a literal", () => {
    render(<PinwheelDivider density={1} />)

    const g = document.querySelector("svg g")
    expect(g?.getAttribute("fill")).toBe("var(--rpc-border-subtle)")
    expect(g?.getAttribute("stroke")).toBe("var(--rpc-border-subtle)")
  })

  it("lets a caller override style without losing the decorative defaults", () => {
    render(<PinwheelDivider style={{ marginTop: 40 }} />)

    const wrap = document.querySelector<HTMLElement>("[aria-hidden]")
    expect(wrap?.style.marginTop).toBe("40px")
    expect(wrap?.style.pointerEvents, "an overridable divider must still not eat clicks").toBe("none")
  })
})

describe("ConsoleGreeting", () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    vi.resetModules()
  })

  it("renders no DOM at all", () => {
    const { container } = render(<ConsoleGreeting />)
    expect(container.innerHTML).toBe("")
  })

  it("greets at most once per page load, however many times it mounts", async () => {
    // The `greeted` latch is module-level on purpose: the component sits in the
    // root layout and React 19 StrictMode double-invokes effects in dev, so
    // without it every reader sees the banner twice.
    const { default: Fresh } = await import("@/components/visual/ConsoleGreeting")

    render(<Fresh />)
    const afterFirst = logSpy.mock.calls.length
    cleanup()
    render(<Fresh />)

    expect(afterFirst).toBeLessThanOrEqual(1)
    expect(logSpy.mock.calls.length).toBe(afterFirst)
  })

  it("the one sanctioned hardcode of #E03A2F is here, and it is here for a stated reason", () => {
    // ⚠ Deliberately pinned, not banned. `check-brand-tokens` forbids the
    // literal everywhere else; DevTools `%c` styling cannot read a CSS custom
    // property, so this call site genuinely cannot use `var(--rpc-red)`. The
    // risk is not the hardcode, it is the hardcode losing the comment that
    // explains it and becoming citable precedent.
    const src = read("components", "visual", "ConsoleGreeting.tsx")
    expect(src).toContain("#E03A2F")

    // ⚠ MATCH THE PROSE, NOT ITS LINE WRAPPING. This assertion red-ed CI on
    // 2026-08-22 because the comment was RE-WRAPPED — a legitimate edit that
    // changed no meaning. Pin the property, not the spelling: strip the `//`
    // markers and collapse whitespace before matching.
    const prose = src.replace(/^[ \t]*\/\/ ?/gm, " ").replace(/\s+/g, " ")

    // ⚠ The old assertion here was /only sanctioned hardcode/i, and it had gone
    // VACUOUS: the deep audit found that claim to be false (the recharts SVG
    // strokes and the email accent are sanctioned too), so the comment was
    // rewritten to REFUTE it — and the regex went on matching, now against the
    // refutation rather than the claim. Assert the machine-readable marker.
    expect(prose, "the exemption must carry its brand-exception marker").toMatch(
      /brand-exception:/,
    )
    expect(
      prose,
      "the exemption must keep stating the REASON — a var() cannot be read by DevTools %c styling",
    ).toMatch(/var\(--rpc-red\)\) are not readable inside DevTools/)
  })

  it("never throws out of a greeting when console is unavailable", () => {
    // The component wraps its own log in try/catch. Verified rather than
    // assumed: an exception here would take the root layout down for a banner.
    logSpy.mockImplementation(() => {
      throw new Error("console gone")
    })
    expect(() => render(<ConsoleGreeting />)).not.toThrow()
  })
})
