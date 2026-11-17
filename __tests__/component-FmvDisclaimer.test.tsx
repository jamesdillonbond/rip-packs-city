// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { readFileSync } from "node:fs"
import path from "node:path"
import FmvDisclaimer from "@/components/legal/FmvDisclaimer"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// `components/legal/` matched no glob in the component gate's curated `include`,
// so this component was unmeasured and untested. It is the platform's standing
// "FMV is not investment advice" disclosure — a legal surface on a product whose
// entire value proposition is a price estimate. The interesting properties are
// the two it must never lose: the disclaimer TEXT, and the methodology link that
// makes the estimate auditable.

afterEach(cleanup)

const SRC = readFileSync(
  path.resolve(__dirname, "..", "components", "legal", "FmvDisclaimer.tsx"),
  "utf8",
)

describe("FmvDisclaimer — the disclosure itself", () => {
  it("the short variant says the estimate is not investment advice", () => {
    render(<FmvDisclaimer />)

    expect(screen.getByText(/not investment advice/i)).toBeTruthy()
  })

  it("the full variant keeps the volatility caveat, not just the advice disclaimer", () => {
    render(<FmvDisclaimer variant="full" />)

    // Three distinct claims, each load-bearing. A rewrite that keeps only "not
    // investment advice" drops the part that explains WHY the number moves.
    const text = document.body.textContent ?? ""
    expect(text).toMatch(/estimates only/i)
    expect(text).toMatch(/do not constitute investment advice/i)
    expect(text).toMatch(/past prices\s+do not predict future prices/i)
  })

  it("short is the default — a bare <FmvDisclaimer /> is never the empty render", () => {
    // The variant is a defaulted prop, so a typo'd union member would fall
    // through to `undefined` and hit neither branch if the code were ever
    // rewritten as a lookup. Pin that the default renders something real.
    render(<FmvDisclaimer />)
    expect((document.body.textContent ?? "").trim().length).toBeGreaterThan(20)
  })

  it("the two variants are actually different renders", () => {
    // Guards the mutation where both branches collapse to one: the full variant
    // is a block-level panel, the short one an inline span that sits beside a
    // price. Losing the distinction silently reflows every pricing surface.
    const { container: short } = render(<FmvDisclaimer />)
    const shortHtml = short.innerHTML
    // Read the shape BEFORE unmounting — `cleanup()` empties the container, so
    // a query against it afterwards answers null whatever the component did.
    expect(short.querySelector("span")).not.toBeNull()
    cleanup()

    const { container: full } = render(<FmvDisclaimer variant="full" />)
    expect(full.innerHTML).not.toBe(shortHtml)
    expect(full.querySelector("div")).not.toBeNull()
  })
})

describe("FmvDisclaimer — the methodology link", () => {
  it("both variants link to the methodology page by default", () => {
    render(<FmvDisclaimer />)
    expect(document.querySelector('a[href="/legal/fmv-methodology"]')).not.toBeNull()
    cleanup()

    render(<FmvDisclaimer variant="full" />)
    expect(document.querySelector('a[href="/legal/fmv-methodology"]')).not.toBeNull()
  })

  it("showMethodologyLink={false} drops the link WITHOUT dropping the disclaimer", () => {
    // ⚠ The failure worth catching is not a missing link, it is a caller that
    // suppresses the link and takes the disclosure with it. Assert both halves.
    render(<FmvDisclaimer showMethodologyLink={false} />)

    expect(document.querySelector('a[href="/legal/fmv-methodology"]')).toBeNull()
    expect(screen.getByText(/not investment advice/i)).toBeTruthy()
  })

  it("the same is true of the full variant", () => {
    render(<FmvDisclaimer variant="full" showMethodologyLink={false} />)

    expect(document.querySelector("a")).toBeNull()
    expect(document.body.textContent).toMatch(/do not constitute investment advice/i)
  })

  it("the link target matches a route that exists", () => {
    // A dead legal link is worse than none: it reads as a citation and answers
    // 404. Checked against the filesystem so a route rename reds here.
    const page = path.resolve(__dirname, "..", "app", "legal", "fmv-methodology", "page.tsx")
    expect(() => readFileSync(page, "utf8")).not.toThrow()
  })
})

describe("FmvDisclaimer — brand tokens", () => {
  it("hardcodes neither the brand red nor the display font", () => {
    // `#E03A2F` and `Barlow Condensed` come from `app/rpc-tokens.css`. A
    // hardcoded dark hex also renders a black slab in light mode, because
    // `--rpc-black` / `--rpc-text-primary` are theme-aware.
    const code = stripComments(SRC)
    expect(code).not.toMatch(/#E03A2F/i)
    expect(code).not.toMatch(/Barlow Condensed/)
  })

  it("the accessibility of the icon does not depend on its glyph", () => {
    // The "i" badge is decoration beside real text; it must stay aria-hidden so
    // a screen reader reads the sentence, not "i For informational purposes".
    render(<FmvDisclaimer />)
    const hidden = document.querySelector("[aria-hidden]")
    expect(hidden?.textContent).toBe("i")
  })
})
