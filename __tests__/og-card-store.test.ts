import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// lib/og/card-store — why a pasted link now gets a preview (2026-11-07).
// Discord showed nothing for rippackscity.com/profile/peanpean: the card took
// ~10.8 s (p50) to render cold, longer than the crawler waits. The store serves
// the rendered PNG instantly and keeps it fresh in the background.

import { serveStoredCard, ogCardKey, OG_CARD_FRESH_MS, OG_CARD_FULL_HEADER, SUPABASE_STORAGE_KEY_RE } from "@/lib/og/card-store"
import { ogProfileCardPath, ogTrophyCaseCardPath, OG_CARD_URL_VERSION } from "@/lib/og/card-url"

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

  it("⚠ a store write that FAILS is tagged rendered-not-stored — never 'rendered'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: RequestInit) =>
        init?.method === "POST" ? new Response("{}", { status: 400 }) : new Response("nf", { status: 400 }),
      ),
    )
    const res = await serveStoredCard({ key: "k.png", render: async () => card(NEW), fallback, waitUntil: () => {} })
    expect(res.headers.get("X-Og-Card-Source")).toBe("rendered-not-stored")
    expect(await bytesOf(res)).toEqual(Array.from(NEW))
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

describe("card URLs carry a version (Discord's media proxy remembers a FAILED image URL)", () => {
  it("both card URLs are versioned — a failure cached under the bare URL is never asked for again", () => {
    expect(OG_CARD_URL_VERSION).not.toBe("")
    expect(ogProfileCardPath("peanpean")).toBe(`/api/og/profile/peanpean?v=${OG_CARD_URL_VERSION}`)
    expect(ogTrophyCaseCardPath("trev")).toBe(`/api/og/trophy-case/trev?v=${OG_CARD_URL_VERSION}`)
  })
})

// ⚠ tetrislblock (2026-11-07): the Dame Time card was stored after pin 1 and a
// link pasted a minute later (6 pinned) unfurled with ONE Moment. The URL — and
// the store key — now carry the case's contents.
import { pinsToken as tokenOf, cleanCardToken } from "@/lib/og/card-url"
describe("card content token", () => {
  const one = [{ slot: 1, moment_id: "a" }]
  const six = [1, 2, 3, 4, 5, 6].map((s) => ({ slot: s, moment_id: "m" + s }))
  it("changes when a pin is added, removed or moved — and only then", () => {
    expect(tokenOf(one)).not.toBe(tokenOf(six))
    expect(tokenOf(six)).toBe(tokenOf([...six].reverse())) // order of the ARRAY is not content
    const moved = six.map((p) => (p.slot === 1 ? { ...p, slot: 2 } : p.slot === 2 ? { ...p, slot: 1 } : p))
    expect(tokenOf(moved)).not.toBe(tokenOf(six)) // a reorder IS content
    expect(tokenOf([])).toBe("0")
  })
  it("tokens are what the routes accept, and the store key carries them", () => {
    expect(cleanCardToken(tokenOf(six))).toBe(tokenOf(six))
    expect(cleanCardToken("../x")).toBeNull()
    expect(ogCardKey("trophy-case", "Trev", "dame-time", "abc")).toBe("trophy-case/trev/dame-time.abc.png")
    expect(ogCardKey("profile", "Trev", null, "abc")).toBe("profile/trev.abc.png")
  })
})

// ⚠ 2026-11-07: the first tokened keys used `~`, which Supabase Storage refuses
// (400). Every tokened card rendered, failed to store, and was served anyway —
// so nothing looked wrong. Every key SHAPE must be one Storage accepts.
describe("every store key is one Supabase Storage accepts", () => {
  it("all kinds, with and without slug and token", () => {
    const keys = [
      ogCardKey("profile", "peanpean"),
      ogCardKey("profile", "PeanPean", null, tokenOf([{ slot: 1, moment_id: "a" }])),
      ogCardKey("trophy-case", "trev"),
      ogCardKey("trophy-case", "trev", null, "1fock6c"),
      ogCardKey("trophy-case", "trev", "dame-time"),
      ogCardKey("trophy-case", "trev", "dame-time", "hdfilf"),
      ogCardKey("challenge", "dame-time"),
    ]
    for (const k of keys) expect(k, k).toMatch(SUPABASE_STORAGE_KEY_RE)
    expect("trophy-case/trev/dame-time~abc.png").not.toMatch(SUPABASE_STORAGE_KEY_RE) // the shape that shipped
  })
})
