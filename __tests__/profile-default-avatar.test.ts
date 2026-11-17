import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { readSite } from "./helpers/page-source"
import {
  DEFAULT_AVATAR_URL,
  resolveAvatarUrl,
  isDefaultAvatar,
} from "@/lib/profile/default-avatar"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// The RPC logo is the avatar a collector gets before they set one. It is a
// RENDER-time default, so `profile_bio.avatar_url` keeps NULL meaning "not
// chosen" — see the module header for why the column-DEFAULT + backfill route
// was rejected (an explicit NULL from the POST path defeats a column DEFAULT,
// so it would have been inert on the main creation path while looking correct).

describe("resolveAvatarUrl", () => {
  it("returns the RPC logo for every spelling of 'unset'", () => {
    // NULL is the DB state; undefined is a missing row/field; whitespace is
    // what a text input produces when someone clears it with the spacebar.
    for (const unset of [null, undefined, "", "   ", "\t\n"]) {
      expect(resolveAvatarUrl(unset)).toBe(DEFAULT_AVATAR_URL)
    }
  })

  it("returns the collector's own avatar untouched when they have set one", () => {
    expect(resolveAvatarUrl("https://example.com/me.png")).toBe(
      "https://example.com/me.png",
    )
    expect(resolveAvatarUrl("  https://example.com/me.png  ")).toBe(
      "https://example.com/me.png",
    )
  })

  it("does NOT substitute the logo for a broken value the collector saved", () => {
    // Hiding their own bad input behind something that looks deliberate would
    // make it unfixable-by-inspection. Every render site degrades a failed
    // image load to the monogram, which is the honest outcome here.
    expect(resolveAvatarUrl("not-a-url")).toBe("not-a-url")
    expect(resolveAvatarUrl("javascript:alert(1)")).toBe("javascript:alert(1)")
  })

  it("isDefaultAvatar distinguishes 'never chose' from 'chose something'", () => {
    expect(isDefaultAvatar(null)).toBe(true)
    expect(isDefaultAvatar(DEFAULT_AVATAR_URL)).toBe(true)
    expect(isDefaultAvatar("https://example.com/me.png")).toBe(false)
  })
})

describe("DEFAULT_AVATAR_URL is reachable by the SERVER-SIDE consumers", () => {
  // Two consumers fetch this URL over HTTP with no session — the profile OG
  // card (edge runtime, so it cannot read the file off disk) and the
  // trophy-case PDF. Both properties below are what make that work, and
  // neither is visible in any rendered output, so nothing else would catch a
  // regression until a social card silently lost its avatar.

  it("is absolute https, which the OG card requires before it will embed it", () => {
    // app/api/og/profile/[username]/route.tsx gates the prefetch on
    // startsWith("https://"). A relative path would silently render the
    // monogram on every card instead.
    expect(DEFAULT_AVATAR_URL.startsWith("https://")).toBe(true)
  })

  it("points at a file that actually exists in public/", () => {
    const file = new URL(DEFAULT_AVATAR_URL).pathname
    expect(
      fs.existsSync(path.join(process.cwd(), "public", file)),
    ).toBe(true)
  })

  it("is an EXACT member of STATIC_ROOT_ASSETS, so the auth wall lets it through", () => {
    // ⚠ If it is ever moved somewhere gated, those two server-side fetches do
    // NOT get a 404: proxy.ts 302s to /login and they receive an HTML document
    // at status 200, which satori then dies on from inside the ImageResponse
    // stream — after GET has returned, where the route's try/catch cannot
    // reach it. That is exactly how /fonts/*.ttf stayed broken for weeks.
    const proxy = fs.readFileSync(
      path.join(process.cwd(), "proxy.ts"),
      "utf8",
    )
    const block = proxy.match(/STATIC_ROOT_ASSETS = new Set\(\[([\s\S]*?)\]\)/)
    expect(block, "STATIC_ROOT_ASSETS block not found in proxy.ts").toBeTruthy()
    const entries = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    expect(entries).toContain(new URL(DEFAULT_AVATAR_URL).pathname)
  })
})

describe("every avatar render site goes through the shared default", () => {
  // A source guard, because there is no type that forbids reading
  // `bio.avatar_url` straight into an <img src>. The failure it prevents is
  // one surface quietly keeping the monogram after the others moved — which
  // is not a crash, just an inconsistency nobody notices until a collector
  // asks why their card and their page disagree.
  const SITES = [
    "app/profile/[username]/ProfileClient.tsx",
    "app/(collections)/[collection]/profile/[username]/page.tsx",
    "app/api/og/profile/[username]/route.tsx",
    "components/profile/ProfileHeaderPreview.tsx",
  ]

  // ⚠ `readSite`, not `readFileSync`. This list MIXES a client component, a
  // collection page, an OG route and a preview component, and the `page.tsx`
  // entry is the one that silently stops covering anything the day that page is
  // split into a sibling `*Client.tsx` — which happened to
  // `[collection]/profile/[username]` on 2026-08-16 and reddened this guard on a
  // refactor that moved `resolveAvatarUrl` rather than removing it.
  it.each(SITES)("%s resolves through resolveAvatarUrl", (rel) => {
    const src = readSite(rel)
    expect(src).toContain("resolveAvatarUrl")
  })

  it("no render site feeds a raw avatar_url straight into an <img src>", () => {
    // Comments are stripped first: several of these files QUOTE the old
    // `src={bio.avatar_url}` in the comment explaining the change, and this
    // repo has repeatedly had guards trip on their own documentation.
    for (const rel of SITES) {
      const src = stripComments(readSite(rel))
      expect(src, `${rel} passes a raw avatar_url to an img src`).not.toMatch(
        /src=\{\s*bio[!?]?\.avatar_url/,
      )
    }
  })
})
