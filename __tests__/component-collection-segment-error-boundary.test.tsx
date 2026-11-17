// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, screen } from "@testing-library/react"
import { existsSync, readFileSync } from "node:fs"
import React from "react"

// deep-audit R19. `/nba-top-shot/set/base-set` and
// `/nba-top-shot/team/los-angeles-lakers` were observed serving Next's DEFAULT
// error page — bare, unbranded, no way back — while every other public surface
// on the site degrades honestly and in brand. Both are linked directly from the
// public /nba-top-shot/overview catalog.

const PARAMS: Record<string, string> = { collection: "nba-top-shot" }
vi.mock("next/navigation", () => ({ useParams: () => PARAMS }))

import CollectionSegmentError from "@/app/(collections)/[collection]/error"

afterEach(cleanup)

function renderBoundary(error: Error & { digest?: string }, reset = () => {}) {
  return render(<CollectionSegmentError error={error} reset={reset} />)
}

describe("collection segment error boundary (R19)", () => {
  it("reports OUR failure and does not conclude anything about the data", () => {
    renderBoundary(new Error("boom"))
    const text = document.body.textContent || ""

    expect(text).toContain("Couldn’t render this page")
    // ⚠ The load-bearing assertion is the ABSENCE of a claim about the market.
    // "We couldn't load it" is a claim about US; "there is nothing here" would
    // be a claim about the DATA, and collapsing the two is the top defect class
    // on this platform.
    expect(text).toContain("does not mean the data is missing")
    expect(text).not.toMatch(/no (results|data|moments|sales|listings) (found|yet)/i)
    expect(text).not.toMatch(/\bempty\b/i)
  })

  it("offers a retry that actually calls reset()", () => {
    const reset = vi.fn()
    renderBoundary(new Error("boom"), reset)
    fireEvent.click(screen.getByRole("button", { name: /reload/i }))
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it("routes back to the CURRENT collection, not a hardcoded one", () => {
    PARAMS.collection = "ufc"
    try {
      renderBoundary(new Error("boom"))
      const a = screen.getByRole("link", { name: /back to overview/i }) as HTMLAnchorElement
      expect(a.getAttribute("href")).toBe("/ufc/overview")
    } finally {
      PARAMS.collection = "nba-top-shot"
    }
  })

  it("falls back to the site root rather than fabricating a collection slug", () => {
    const saved = PARAMS.collection
    // Model the unknown-collection case (the param is optional at the type level).
    delete PARAMS.collection
    try {
      renderBoundary(new Error("boom"))
      const a = screen.getByRole("link", { name: /back to overview/i }) as HTMLAnchorElement
      expect(a.getAttribute("href")).toBe("/")
    } finally {
      PARAMS.collection = saved
    }
  })

  it("surfaces the digest when there is one, and renders nothing when there is not", () => {
    const withDigest = renderBoundary(Object.assign(new Error("boom"), { digest: "abc123" }))
    expect(document.body.textContent).toContain("ref abc123")
    withDigest.unmount()
    renderBoundary(new Error("boom"))
    expect(document.body.textContent).not.toContain("ref ")
  })

  it("is placed at the COLLECTION segment so new entity routes inherit it", () => {
    // ⚠ This is the anti-D12b assertion. A boundary added only to the two routes
    // observed failing (set/, team/) would leave every other heavy entity page —
    // and every route added later — bailing to Next's default page. Pin the
    // PLACEMENT, because that is the property that gives it blast radius.
    expect(existsSync("app/(collections)/[collection]/error.tsx")).toBe(true)

    const src = readFileSync("app/(collections)/[collection]/error.tsx", "utf8")
    // console.warn is NOT indexed in Vercel runtime logs, so a warn here would
    // make this whole failure class unsearchable after the fact.
    expect(src).toContain("console.log(")
    expect(src).not.toContain("console.warn(")
  })

  it("uses theme-aware tokens, not hardcoded neutrals", () => {
    // A hardcoded #fff / rgba(255,255,255,…) renders invisible in light mode —
    // the documented footgun, and the pre-existing pack/dist boundary has it.
    const src = readFileSync("app/(collections)/[collection]/error.tsx", "utf8")
    const styleOnly = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")
    expect(styleOnly).not.toMatch(/#fff\b|#ffffff\b/i)
    expect(styleOnly).not.toMatch(/rgba\(\s*255\s*,\s*255\s*,\s*255/)
    expect(styleOnly).toContain("var(--rpc-text-primary)")
  })
})
