import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// lib/og/card-store — why a pasted link now gets a preview (2026-11-07).
// Discord showed nothing for rippackscity.com/profile/peanpean: the card took
// ~10.8 s (p50) to render cold, longer than the crawler waits. The store serves
// the rendered PNG instantly and keeps it fresh in the background.

import { serveStoredCard, ogCardKey, OG_CARD_FRESH_MS, OG_CARD_FULL_HEADER } from "@/lib/og/card-store"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const NEW = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9])
let stored: { bytes: Uint8Array; modified: number } | null
let writes: Array<{ url: string; bytes: number }>

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc"
  stored = null
  writes = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const b = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer())
        writes.push({ url, bytes: b.length })
        stored = { bytes: b, modified: Date.now() }
        return new Response("{}", { status: 200 })
      }
      if (!stored) return new Response("not found", { status: 400 })
      return new Response(stored.bytes as Uint8Array<ArrayBuffer>, {
        status: 200,
        headers: { "content-type": "image/png", "last-modified": new Date(stored.modified).toUTCString() },
      })
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

const card = (bytes: Uint8Array, full = true) =>
  new Response(bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: { "content-type": "image/png", ...(full ? { [OG_CARD_FULL_HEADER]: "full" } : {}) },
  })
const fallback = async () => new Response(new Uint8Array([7]), { status: 200, headers: { "content-type": "image/png", "Cache-Control": "public, s-maxage=3600" } })
const bytesOf = async (r: Response) => Array.from(new Uint8Array(await r.arrayBuffer()))

describe("serveStoredCard", () => {
  it("a FRESH stored card is served without rendering", async () => {
    stored = { bytes: PNG, modified: Date.now() - 60_000 }
    const render = vi.fn(async () => card(NEW))
    const waits: Promise<unknown>[] = []
    const res = await serveStoredCard({ key: "k.png", render, fallback, waitUntil: (p) => waits.push(p) })
    expect(await bytesOf(res)).toEqual(Array.from(PNG))
    expect(res.headers.get("X-Og-Card-Source")).toBe("stored")
    expect(render).not.toHaveBeenCalled()
    expect(waits).toHaveLength(0)
  })

  it("a STALE stored card is served at once and re-rendered + re-stored in the background", async () => {
    stored = { bytes: PNG, modified: Date.now() - OG_CARD_FRESH_MS - 60_000 }
    const waits: Promise<unknown>[] = []
    const res = await serveStoredCard({ key: "k.png", render: async () => card(NEW), fallback, waitUntil: (p) => waits.push(p) })
    expect(await bytesOf(res)).toEqual(Array.from(PNG))
    await Promise.all(waits)
    expect(writes).toHaveLength(1)
    expect(Array.from(stored!.bytes)).toEqual(Array.from(NEW))
  })

  it("a MISS that renders in time returns the card and stores it", async () => {
    const res = await serveStoredCard({ key: "trophy-case/trev.png", render: async () => card(NEW), fallback, waitUntil: () => {} })
    expect(await bytesOf(res)).toEqual(Array.from(NEW))
    expect(writes[0].url).toBe("https://db.example/storage/v1/object/og-cards/trophy-case/trev.png")
  })

  it("⚠ a MISS that misses the deadline gets the fallback at a 60 s cache — and the real card still lands in the store", async () => {
    let finish!: () => void
    const slow = new Promise<void>((r) => (finish = r))
    const waits: Promise<unknown>[] = []
    const res = await serveStoredCard({
      key: "k.png",
      render: async () => {
        await slow
        return card(NEW)
      },
      fallback,
      waitUntil: (p) => waits.push(p),
      deadlineMs: 10,
    })
    expect(await bytesOf(res)).toEqual([7])
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=60")
    finish()
    await Promise.all(waits)
    expect(Array.from(stored!.bytes)).toEqual(Array.from(NEW))
  })

  it("⚠ a card NOT marked full (missing art, failed read, fallback) is served but never stored", async () => {
    const res = await serveStoredCard({ key: "k.png", render: async () => card(NEW, false), fallback, waitUntil: () => {} })
    expect(await bytesOf(res)).toEqual(Array.from(NEW))
    expect(writes).toHaveLength(0)
  })

  it("a storage outage degrades to rendering, never to an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down") }))
    const res = await serveStoredCard({ key: "k.png", render: async () => card(NEW), fallback, waitUntil: () => {} })
    expect(res.status).toBe(200)
    expect(await bytesOf(res)).toEqual(Array.from(NEW))
  })
})

describe("ogCardKey", () => {
  it("is case-insensitive on the handle and names the challenge", () => {
    expect(ogCardKey("profile", "PeanPean")).toBe("profile/peanpean.png")
    expect(ogCardKey("trophy-case", "Trev", "dame-time")).toBe("trophy-case/trev/dame-time.png")
  })
})
