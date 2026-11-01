import { describe, it, expect, vi, beforeEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import sharp from "sharp"
import { NextRequest } from "next/server"
import { IPFS_THUMB_MIRROR_BUCKET, IPFS_THUMB_WIDTHS, ipfsThumbMirrorKey } from "@/lib/ipfs-media"

// ── 2026-11-01: the owner's UFC trophy rendered as a broken image ────────────────────────────────
// UFC art is only on public IPFS, and every gateway failed it inside ipfs-media's 8 s budget
// (Dapper 403 · Pinata timeout · ipfs.io 429). The resized bytes now live in a Supabase Storage
// mirror that /api/public/ipfs-thumb reads FIRST. Pinned here: a hit touches no gateway; a miss
// resizes AND writes back; a broken mirror never breaks the image; and the backfill script writes
// the same keys with the same resize the route does.

const CID = "QmdUicBPH1qxNtdNViPWokPAc59j8eJoYAEEg2irFwR6Di"
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!
const mirrorPublic = (w: number) => `${SB}/storage/v1/object/public/${IPFS_THUMB_MIRROR_BUCKET}/${CID}/${w}.webp`
const mirrorWrite = (w: number) => `${SB}/storage/v1/object/${IPFS_THUMB_MIRROR_BUCKET}/${CID}/${w}.webp`
const ORIGINAL = `https://www.rippackscity.com/api/public/ipfs-media/${CID}`

const fetchMock = vi.fn()
vi.stubGlobal("fetch", fetchMock)
const { GET } = await import("@/app/api/public/ipfs-thumb/[cid]/route")
const call = (w: string) =>
  GET(new NextRequest(`https://www.rippackscity.com/api/public/ipfs-thumb/${CID}?w=${w}`), { params: Promise.resolve({ cid: CID }) })

const png = () =>
  sharp({ create: { width: 1200, height: 1500, channels: 4, background: { r: 10, g: 120, b: 200, alpha: 1 } } }).png().toBuffer()
const urls = () => fetchMock.mock.calls.map(([u]) => String(u))

type Handler = (init?: RequestInit) => Response | Promise<Response>
function routes(map: Record<string, Handler>) {
  fetchMock.mockImplementation(async (u: unknown, init?: RequestInit) => {
    const h = map[String(u)]
    if (!h) throw new Error(`unexpected fetch ${String(u)}`)
    return h(init)
  })
}

describe("ipfs-thumb reads the mirror first", () => {
  // Braces matter: a function RETURNED from beforeEach runs as a cleanup hook, and mockReset returns the mock.
  beforeEach(() => { fetchMock.mockReset() })

  it("serves a mirror hit directly and touches NO gateway", async () => {
    const hit = await sharp(await png()).resize({ width: 640 }).webp().toBuffer()
    routes({ [mirrorPublic(640)]: () => new Response(new Uint8Array(hit), { status: 200, headers: { "content-type": "image/webp" } }) })
    const res = await call("640")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/webp")
    expect(res.headers.get("cache-control")).toContain("immutable")
    expect(Buffer.from(await res.arrayBuffer()).equals(hit)).toBe(true)
    expect(urls()).toEqual([mirrorPublic(640)])
  })

  it("on a miss, resizes from the original AND writes the result back to the mirror", async () => {
    const original = await png()
    let written: Uint8Array | null = null
    let writeHeaders: Headers | null = null
    routes({
      [mirrorPublic(320)]: () => new Response(null, { status: 400 }),
      [ORIGINAL]: () => new Response(new Uint8Array(original), { status: 200, headers: { "content-type": "image/png" } }),
      [mirrorWrite(320)]: (init) => {
        written = init?.body as Uint8Array
        writeHeaders = new Headers(init?.headers)
        return new Response("{}", { status: 200 })
      },
    })
    const res = await call("320")
    expect(res.status).toBe(200)
    const served = Buffer.from(await res.arrayBuffer())
    expect((await sharp(served).metadata()).width).toBe(320)
    // What was kept is byte-for-byte what was served, written with the service role, upserted.
    expect(written).not.toBeNull()
    expect(Buffer.from(written!).equals(served)).toBe(true)
    expect(writeHeaders!.get("x-upsert")).toBe("true")
    expect(writeHeaders!.get("content-type")).toBe("image/webp")
    expect(writeHeaders!.get("authorization")).toBe(`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`)
    expect(res.headers.get("x-ipfs-thumb")).toContain("mirror-write=ok")
  })

  it("a mirror that is DOWN (throws / 5xx) falls through to the gateway path — never a broken image", async () => {
    const original = await png()
    for (const down of [() => { throw new Error("ECONNRESET") }, () => new Response(null, { status: 503 })] as Handler[]) {
      fetchMock.mockReset()
      routes({
        [mirrorPublic(160)]: down,
        [ORIGINAL]: () => new Response(new Uint8Array(original), { status: 200, headers: { "content-type": "image/png" } }),
        [mirrorWrite(160)]: () => new Response("{}", { status: 200 }),
      })
      const res = await call("160")
      expect(res.status).toBe(200)
      expect((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).width).toBe(160)
    }
  })

  it("a FAILED write-back still serves the resized image, and says the write failed", async () => {
    const original = await png()
    routes({
      [mirrorPublic(640)]: () => new Response(null, { status: 404 }),
      [ORIGINAL]: () => new Response(new Uint8Array(original), { status: 200, headers: { "content-type": "image/png" } }),
      [mirrorWrite(640)]: () => new Response("nope", { status: 500 }),
    })
    const res = await call("640")
    expect(res.status).toBe(200)
    expect(res.headers.get("x-ipfs-thumb")).toContain("mirror-write=failed")
    expect(res.headers.get("x-ipfs-thumb")).not.toContain("mirror-write=ok")
  })

  it("a mirror answer that is not WebP is not served as the image", async () => {
    routes({
      [mirrorPublic(640)]: () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
      [ORIGINAL]: () => new Response(null, { status: 429 }),
    })
    const res = await call("640")
    // Falls through; the original also failed, so it fails OPEN to the original URL.
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(ORIGINAL)
  })
})

describe("the backfill script and the route agree", () => {
  it("same bucket, same key shape, same widths", async () => {
    const script = await import("../scripts/ipfs-thumb-mirror.mjs")
    expect(script.BUCKET).toBe(IPFS_THUMB_MIRROR_BUCKET)
    expect(script.WIDTHS).toEqual([...IPFS_THUMB_WIDTHS])
    for (const w of IPFS_THUMB_WIDTHS) expect(script.mirrorKey(CID, w)).toBe(ipfsThumbMirrorKey(CID, w))
  })

  it("the script's resize is byte-identical to the route's for the same original", async () => {
    const original = await png()
    const script = await import("../scripts/ipfs-thumb-mirror.mjs")
    fetchMock.mockReset()
    let written: Uint8Array | null = null
    routes({
      [mirrorPublic(320)]: () => new Response(null, { status: 400 }),
      [ORIGINAL]: () => new Response(new Uint8Array(original), { status: 200, headers: { "content-type": "image/png" } }),
      [mirrorWrite(320)]: (init) => { written = init?.body as Uint8Array; return new Response("{}", { status: 200 }) },
    })
    await call("320")
    const fromScript: Buffer = await script.resizeToWebp(original, 320)
    expect(Buffer.from(written!).equals(fromScript)).toBe(true)
  })

  it("the bucket the code names is the one the migration creates", () => {
    const dir = path.join(process.cwd(), "supabase/migrations")
    const files = fs.readdirSync(dir).filter((f) => f.includes("ipfs_thumb_mirror_bucket"))
    expect(files.length).toBe(1)
    expect(fs.readFileSync(path.join(dir, files[0]), "utf8")).toContain(`values ('${IPFS_THUMB_MIRROR_BUCKET}', '${IPFS_THUMB_MIRROR_BUCKET}', true`)
  })
})
