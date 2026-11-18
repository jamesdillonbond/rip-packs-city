import { describe, expect, it } from "vitest"
import { NEW_ITEMS, buildNewItemsBlock, currentNewItems } from "@/lib/emails/weekly-digest-news"

describe("weekly email — New on Rip Packs City block (2026-11-17)", () => {
  it("shows every item in the weeks after it shipped, with tagged links", () => {
    const { html, text } = buildNewItemsBlock("https://www.rippackscity.com", new Date("2026-11-23T16:00:00Z"))
    for (const i of NEW_ITEMS) expect(html).toContain(i.title)
    expect(html).toContain("utm_source=email&amp;utm_medium=weekly_digest&amp;utm_campaign=new_serial_search")
    expect(text.join("\n")).toContain("utm_campaign=new_compare")
  })

  it("an item drops out by itself after its window — nothing stale reads as new", () => {
    expect(currentNewItems(new Date("2027-01-15T00:00:00Z"))).toEqual([])
    expect(buildNewItemsBlock("https://www.rippackscity.com", new Date("2027-01-15T00:00:00Z"))).toEqual({ html: "", text: [] })
  })

  it("an item is not shown before it shipped", () => {
    expect(currentNewItems(new Date("2026-11-15T00:00:00Z")).map((i) => i.title)).not.toContain("Compare collections")
  })
})
