import { describe, it, expect, vi, afterEach } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { NextRequest } from "next/server"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pinnacleBadgesFor, PINNACLE_BADGE_SLUGS, PINNACLE_BADGE_ASSETS, pinnacleBadgeIconUrl } from "@/lib/pinnacle/pin-badges"
import PinnacleBadges from "@/components/pinnacle/PinnacleBadges"
import { GET } from "@/app/api/badge-image/route"

// 2026-11-23: Disney Pinnacle's OWN badges with its own art (disneypinnacle.com/news/digital-pins-101). A badge is a
// claim, so it is derived only from catalog facts whose meaning Pinnacle defines; nothing for Legendary/Genesis,
// Magic Reveal or Pin Limitation (no field says so).

afterEach(() => vi.restoreAllMocks())

const pin = (edition_type: string | null, printing: number | null, is_chaser: boolean | null) => ({ edition_type, printing, is_chaser })

describe("pinnacleBadgesFor", () => {
  it("maps Pinnacle's own definitions", () => {
    expect(pinnacleBadgesFor(pin("Open Edition", 1, false))).toEqual(["open-edition", "first-printing"])
    expect(pinnacleBadgesFor(pin("Open Edition", 2, true))).toEqual(["open-edition", "chaser"])
    expect(pinnacleBadgesFor(pin("Open Event Edition", 1, false))).toEqual(["open-edition", "first-printing"])
    expect(pinnacleBadgesFor(pin("Limited Edition", 1, true))).toEqual(["limited-edition", "single-printing", "chaser"])
    expect(pinnacleBadgesFor(pin("Limited Event Edition", 1, false))).toEqual(["limited-edition", "single-printing"])
    expect(pinnacleBadgesFor(pin("Starter Edition", 1, false))).toEqual(["starter-edition"])
  })
  it("earns nothing it cannot prove", () => {
    expect(pinnacleBadgesFor(pin("Legendary Edition", 1, false))).toEqual([])
    expect(pinnacleBadgesFor(pin("Genesis Edition", 1, false))).toEqual([])
    expect(pinnacleBadgesFor(pin(null, null, null))).toEqual([])
    expect(pinnacleBadgesFor(pin("Open Edition", null, null))).toEqual(["open-edition"])
  })
  it("every slug has art", () => {
    for (const s of PINNACLE_BADGE_SLUGS) expect(PINNACLE_BADGE_ASSETS[s]).toMatch(/^[A-Za-z0-9]+\/[0-9a-f]{32}\/[A-Za-z_()0-9]+\.png$/)
  })
})

describe("PinnacleBadges", () => {
  it("renders the same-origin icon with its meaning", () => {
    const html = renderToStaticMarkup(<PinnacleBadges badges={["chaser"]} showLabels />)
    expect(html).toContain(pinnacleBadgeIconUrl("chaser").replace(/&/g, "&amp;"))
    expect(html).toContain("Chaser")
    expect(html).toContain("lower odds")
  })
  it("renders nothing with no badges", () => {
    expect(renderToStaticMarkup(<PinnacleBadges badges={[]} />)).toBe("")
  })
})

describe("/api/badge-image?src=pinnacle", () => {
  it("400s an unknown Pinnacle slug (the allowlist is the injection guard)", async () => {
    expect((await GET(new NextRequest("https://t/api/badge-image?src=pinnacle&name=magic-reveal"))).status).toBe(400)
    expect((await GET(new NextRequest("https://t/api/badge-image?src=pinnacle&name=../x"))).status).toBe(400)
  })
  it("proxies Pinnacle's Contentful art, cropped to the icon", async () => {
    const f = vi.fn(async () => new Response(new Uint8Array([1]).buffer, { status: 200, headers: { "content-type": "image/png" } }))
    vi.stubGlobal("fetch", f)
    const res = await GET(new NextRequest("https://t/api/badge-image?src=pinnacle&name=chaser"))
    expect(res.status).toBe(200)
    const url = String((f.mock.calls[0] as unknown[])[0])
    expect(url).toBe(`https://images.ctfassets.net/2s37rzr5a7pw/${PINNACLE_BADGE_ASSETS.chaser}?w=80&h=80&fit=crop&f=left`)
  })
})

describe("wiring", () => {
  it("the pin page and the checklist tiles render Pinnacle's badges", () => {
    expect(readFileSync(join(process.cwd(), "app/pinnacle/moment/[id]/page.tsx"), "utf8")).toContain("<PinnacleBadges badges={pinBadges}")
    expect(readFileSync(join(process.cwd(), "components/pinnacle/PinnacleCharacterChecklist.tsx"), "utf8")).toContain("<PinnacleBadges badges={pinnacleBadgesFor(p)}")
  })
})
