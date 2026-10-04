import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"

// An IMAGE of IPFS art must go through proxyIpfsImageUrl (/api/public/ipfs-thumb, resized
// WebP), never proxyIpfsUrl (/api/public/ipfs-media, the ORIGINAL). Measured 2026-10-03 on
// Vercel observability: /api/public/ipfs-media served 21.3 GB in one week (≈6,200 human
// requests, ~3.4 MB each), the site's largest egress line, while ipfs-thumb served 48 MB.
// The referrers named Top Shot team pages, the sniper/market, /insights/trophies and edition
// pages: four image sites (TeamChecklist, TrophySlab, MomentMedia.getImageUrl,
// CollectionProfileClient.thumbnailSrc) had been left on the original by the 09-29 sweep
// (222f65ceb), because nothing stopped it. This is that stop.
//
// The rule is a BAN AT ZERO over a tree walk, not an allowlist: every proxyIpfsUrl( call
// outside lib/ipfs-media.ts must be a VIDEO (its argument names video), because a video must
// never reach the resizer (it fails open to the original — a wasted round trip).

const ROOTS = ["app", "components", "lib"]
const HELPER = join("lib", "ipfs-media.ts")

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

/** Every `proxyIpfsUrl(<arg>)` call whose argument does not name a video. */
export function imageCallsOnTheOriginal(src: string): string[] {
  const bad: string[] = []
  const re = /\bproxyIpfsUrl\(([^)]*)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    if (!/video/i.test(m[1])) bad.push(m[0])
  }
  return bad
}

const files = ROOTS.flatMap((r) => walk(join(process.cwd(), r))).filter((f) => !f.endsWith(HELPER))

describe("IPFS images use the resizer, not the original", () => {
  it("inspected a real population", () => {
    expect(files.length).toBeGreaterThan(500)
  })

  it("POSITIVE CONTROL — an image on the original is caught", () => {
    expect(imageCallsOnTheOriginal("<img src={proxyIpfsUrl(e.thumbnail_url) ?? undefined} />")).toHaveLength(1)
    expect(imageCallsOnTheOriginal("return proxyIpfsUrl(prefix);")).toHaveLength(1)
  })

  it("NEGATIVE CONTROL — a video on the original, the resizer, and the absolute variant pass", () => {
    expect(imageCallsOnTheOriginal("<video src={proxyIpfsUrl(slab.video_url) ?? undefined} />")).toHaveLength(0)
    expect(imageCallsOnTheOriginal("videoUrl={proxyIpfsUrl(e.video_url ?? null)}")).toHaveLength(0)
    expect(imageCallsOnTheOriginal("src={proxyIpfsImageUrl(e.thumbnail_url, 640)}")).toHaveLength(0)
    expect(imageCallsOnTheOriginal("proxyIpfsUrlAbsolute(e.thumbnail_url, base)")).toHaveLength(0)
  })

  it("BAN AT ZERO: no image in app/, components/ or lib/ loads the IPFS original", () => {
    const offenders = files
      .flatMap((f) => imageCallsOnTheOriginal(readFileSync(f, "utf8")).map((c) => `${relative(process.cwd(), f).split(sep).join("/")}: ${c}`))
      .sort()
    expect(
      offenders,
      "An <img>/poster of IPFS art must use proxyIpfsImageUrl(url, width) — the original is 2–8 MB.\n" +
        "If this call really is a video, name it (video_url / videoUrl) so the rule can see it.",
    ).toEqual([])
  })
})
