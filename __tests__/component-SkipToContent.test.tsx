// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import SkipToContent, { MainContentAnchor, MAIN_CONTENT_ID, SKIP_LINK_CSS } from "@/components/SkipToContent"

// The skip-to-content link (platform review 2026-10-11, C10). Four properties,
// each of which fails SILENTLY if it drifts — the link still renders, nothing
// errors, and a keyboard user simply gets a dead control:
//   1. the link's href names an element that is actually rendered (the anchor);
//   2. the root layout mounts the link FIRST in <body> and the anchor right
//      before {children} — anywhere else and it skips nothing;
//   3. it is visually hidden until focused, by a transform (not display:none,
//      which would also hide it from assistive tech);
//   4. tokens only, no brand hex, so it is correct in both themes.

afterEach(cleanup)

const layoutSrc = () => readFileSync(join(process.cwd(), "app/layout.tsx"), "utf8")

describe("SkipToContent — the link and its target agree", () => {
  it("the href points at the id the anchor renders, and the anchor is focusable", () => {
    const { container } = render(
      <>
        <SkipToContent />
        <MainContentAnchor />
      </>,
    )
    const link = container.querySelector("a.rpc-skip-link")
    expect(link, "skip link renders as an <a>").not.toBeNull()
    expect(link!.textContent).toMatch(/skip to content/i)
    const href = link!.getAttribute("href") ?? ""
    expect(href.startsWith("#"), `href must be a fragment, got ${href}`).toBe(true)
    const target = container.querySelector(`[id="${href.slice(1)}"]`)
    expect(target, `the skip link targets ${href} but nothing with that id is rendered`).not.toBeNull()
    // tabIndex -1: activating the link FOCUSES the anchor, so the next Tab lands
    // on the first control of the page's own content rather than back at the top.
    expect((target as HTMLElement).tabIndex).toBe(-1)
    expect(target!.id).toBe(MAIN_CONTENT_ID)
  })
})

describe("SkipToContent — mounted by the root layout where it can do its job", () => {
  it("is the FIRST element inside <body>, ahead of MobileNav and every header", () => {
    const src = layoutSrc()
    const body = src.indexOf("<body")
    const skip = src.lastIndexOf("<SkipToContent />") // the JSX, not a comment naming it
    const nav = src.lastIndexOf("<MobileNav />")
    expect(body).toBeGreaterThan(-1)
    expect(skip, "root layout must mount <SkipToContent />").toBeGreaterThan(body)
    expect(skip, "the skip link must precede MobileNav in DOM order").toBeLessThan(nav)
    // Nothing focusable may sit between <body> and the skip link — a link or
    // button there would be the first Tab stop instead.
    const between = src.slice(body, skip)
    expect(between).not.toMatch(/<(a|button|input|select|textarea)\b/)
  })

  it("renders the anchor immediately before {children}", () => {
    const src = layoutSrc()
    // lastIndexOf: the layout's own comment names the element before the JSX does.
    const anchor = src.lastIndexOf("<MainContentAnchor />")
    const children = src.indexOf("{children}", anchor)
    expect(anchor, "root layout must render <MainContentAnchor />").toBeGreaterThan(-1)
    expect(children, "{children} must follow the anchor").toBeGreaterThan(anchor)
    // Only whitespace between them: anything else is content the skip would skip.
    expect(src.slice(anchor + "<MainContentAnchor />".length, children).trim()).toBe("")
  })
})

describe("SkipToContent — visually hidden until focused, tokens only", () => {
  it("hides with a transform (stays in the a11y tree) and restores on :focus", () => {
    render(<SkipToContent />)
    // The <style> is hoisted (href + precedence) so it may land in <head>; read
    // the whole document rather than the container.
    const css = Array.from(document.querySelectorAll("style")).map((s) => s.textContent ?? "").join("\n")
    expect(css).toContain(".rpc-skip-link{")
    const base = css.slice(css.indexOf(".rpc-skip-link{"), css.indexOf(".rpc-skip-link:focus"))
    expect(base).toMatch(/transform:translateY\(-\d+%\)/)
    expect(base).not.toMatch(/display:none|visibility:hidden/)
    expect(css).toMatch(/\.rpc-skip-link:focus\{[^}]*transform:none/)
  })

  it("uses design tokens, never a brand hex or a hardcoded font name", () => {
    expect(SKIP_LINK_CSS).toMatch(/var\(--rpc-red\)/)
    expect(SKIP_LINK_CSS).toMatch(/var\(--rpc-text-primary\)/)
    expect(SKIP_LINK_CSS).toMatch(/var\(--font-display\)/)
    expect(SKIP_LINK_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(SKIP_LINK_CSS).not.toMatch(/Barlow/)
  })
})
