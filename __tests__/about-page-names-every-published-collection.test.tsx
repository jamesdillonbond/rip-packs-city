// 2026-10-15 (deep audit run 6, P2): /about listed five collections — "every Flow
// blockchain digital collectible community — NBA Top Shot, …, UFC Strike" — while
// the home page, which reads the registry, said seven (Panini Blockchain and Candy
// MLB are published). The list is now read from the registry. This pins the
// property, not the spelling: every PUBLISHED label appears in both the rendered
// body and the OG description, so publishing an eighth collection keeps it true.
// Mutation-checked: restoring the hardcoded five-name list reds both cases.

import { describe, it, expect, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { publishedCollections } from "@/lib/collections"

vi.mock("@/components/SupportChatConnected", () => ({ default: () => null }))
vi.mock("@/components/SiteFooter", () => ({ default: () => null }))
vi.mock("@/components/RpcLogo", () => ({ default: () => null }))

const { default: AboutPage, generateMetadata } = await import("@/app/about/page")

const labels = publishedCollections().map((c) => c.label)

describe("/about names every published collection", () => {
  it("the registry publishes more than the five Flow collections (premise)", () => {
    expect(labels.length).toBeGreaterThan(5)
  })

  it("the rendered body names each one", () => {
    const html = renderToStaticMarkup(AboutPage())
    for (const l of labels) expect(html).toContain(l)
  })

  it("the OG description names each one", () => {
    const desc = String(generateMetadata().openGraph?.description ?? "")
    for (const l of labels) expect(desc).toContain(l)
  })
})
