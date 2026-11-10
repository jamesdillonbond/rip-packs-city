import { describe, it, expect } from "vitest"
import { challengeEntryHref, challengeFocusFromUrl } from "@/lib/trophy/challenge-link"
import { parseDashTab } from "@/lib/dashboard-tabs"

// The Dame Time deep link (2026-11-07). The first cut was a `#hash`, which the
// signed-out bounce to /login?next=<path+search> silently drops — the
// collector then lands at the top of the Trophy tab, not the challenge.
describe("challenge deep link", () => {
  it("is a QUERY param, so it rides /login?next= (a fragment never reaches the server)", () => {
    const href = challengeEntryHref("dame-time")
    expect(href).toBe("/dashboard?tab=trophy&challenge=dame-time")
    expect(href).not.toContain("#")
    const url = new URL(href, "https://x")
    const next = url.pathname + url.search // what proxy.ts puts in ?next=
    expect(challengeFocusFromUrl(new URL(next, "https://x").search, "")).toBe("dame-time")
  })
  it("still honours the hash form already shared", () => {
    expect(challengeFocusFromUrl("?tab=trophy", "#challenge-dame-time")).toBe("dame-time")
  })
  it("ignores anything else", () => {
    expect(challengeFocusFromUrl("?tab=trophy", "#other")).toBeNull()
    expect(challengeFocusFromUrl("?challenge=<script>", "")).toBeNull()
    expect(challengeFocusFromUrl("", "")).toBeNull()
  })
  it("tab=trophy is a real tab", () => {
    expect(parseDashTab("trophy")).toBe("trophy")
  })
})

// 2026-11-10: a `?challenge=` link (Enter / Finish your case) now enters and
// opens the picker on arrival instead of only scrolling to the row — 1 of 7
// invite clicks on 11-09 tapped the empty MAIN case instead and left.
import { challengeEntryRequestFrom } from "@/lib/trophy/challenge-link"
import { readFileSync as readSrc11 } from "node:fs"
import { join as join11 } from "node:path"
describe("challengeEntryRequestFrom", () => {
  it("turns a well-formed query slug into the first open-picker request", () => {
    expect(challengeEntryRequestFrom("dame-time")).toEqual({ slug: "dame-time", n: 1 })
  })
  it("asks for nothing without a slug or with a malformed one", () => {
    expect(challengeEntryRequestFrom(null)).toBeNull()
    expect(challengeEntryRequestFrom("")).toBeNull()
    expect(challengeEntryRequestFrom("Dame Time")).toBeNull()
    expect(challengeEntryRequestFrom("x".repeat(81))).toBeNull()
  })
  it("the dashboard seeds its open request from the QUERY param, not the scroll-only hash", () => {
    const src = readSrc11(join11(process.cwd(), "app", "dashboard", "DashboardClient.tsx"), "utf8")
    expect(src).toContain("challengeEntryRequestFrom(challengeParam)")
  })
})
