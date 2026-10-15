import { describe, it, expect, vi } from "vitest"

// 2026-10-14 live SEO audit: Pinnacle pin pages (2,812 sitemap URLs) had a
// title naming no collection ("Remember Me · Golden | Rip Packs City").
vi.mock("@/lib/pinnacle/moment-detail", () => ({
  decodeId: (s: string) => s,
  load: async () => ({
    ok: true,
    data: {
      kind: "pin",
      ed: { render_id: "OEV1-PPTB-REME-S4", character_name: "Remember Me ", set_name: "Pixar • Coco", variant: "Golden", total_minted: 50 },
    },
  }),
}))

import { generateMetadata } from "@/app/pinnacle/moment/[id]/page"

describe("Pinnacle pin page metadata", () => {
  it("the title names the collection, and keeps the pin and variant first", async () => {
    const m = await generateMetadata({ params: Promise.resolve({ id: "OEV1-PPTB-REME-S4" }) })
    expect(String(m.title)).toMatch(/^Remember Me · Golden/)
    expect(String(m.title)).toMatch(/Disney Pinnacle/)
  })
})
