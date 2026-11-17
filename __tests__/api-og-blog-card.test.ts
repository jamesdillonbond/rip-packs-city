import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { BLOG_POSTS } from "@/lib/blog/posts"

// app/api/og/blog/[slug]/route.tsx (2026-10-14). Every post used to unfurl as
// its COLLECTION card. Pins: real PNG bytes at 1200×630 for every post, a 404
// (never a generic 200 picture) for an unknown slug, and every post record
// pointing at its OWN card.

const ROOT = process.cwd()
const PNG_MAGIC = "89504e470d0a1a0a"
let originalFetch: typeof globalThis.fetch

function localFont(url: string): Response {
  const name = url.split("/fonts/")[1]?.split("?")[0] ?? ""
  const file = join(ROOT, "public", "fonts", name)
  if (!existsSync(file)) return new Response("not found", { status: 404 })
  return new Response(new Uint8Array(readFileSync(file)), { status: 200, headers: { "content-type": "font/ttf" } })
}

beforeEach(() => {
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
    if (!/^https?:/i.test(url)) return originalFetch(input as never, init)
    if (url.includes("/fonts/")) return localFont(url)
    throw new Error(`blog card escaped to the network: ${url}`)
  }) as unknown as typeof globalThis.fetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

async function render(slug: string) {
  const mod = await import("@/app/api/og/blog/[slug]/route")
  const res = await mod.GET(new NextRequest("https://www.rippackscity.com/api/og/blog/x"), { params: Promise.resolve({ slug }) })
  return { res, buf: Buffer.from(await res.arrayBuffer()) }
}

describe("app/api/og/blog/[slug] — the post's own share card", () => {
  it.each(BLOG_POSTS.map((p) => p.slug))("%s renders a real 1200×630 PNG", async (slug) => {
    const { res, buf } = await render(slug)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("image/png")
    expect(buf.subarray(0, 8).toString("hex")).toBe(PNG_MAGIC)
    expect(buf.readUInt32BE(16)).toBe(1200)
    expect(buf.readUInt32BE(20)).toBe(630)
  }, 60000)

  it("an unknown slug is a 404, not a generic 200 picture", async () => {
    const { res, buf } = await render("not-a-post")
    expect(res.status).toBe(404)
    expect(buf.subarray(0, 8).toString("hex")).not.toBe(PNG_MAGIC)
  })

  it("every post's share image is its own card, and every post page uses the record (no borrowed collection card)", () => {
    for (const p of BLOG_POSTS) {
      expect(p.image).toBe(`https://www.rippackscity.com/api/og/blog/${p.slug}`)
      const src = readFileSync(join(ROOT, "app", "blog", p.slug, "page.tsx"), "utf8")
      expect(src, p.slug).not.toMatch(/api\/og\/collection\?id=/)
    }
  })
})
