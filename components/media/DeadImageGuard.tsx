"use client"

// components/media/DeadImageGuard.tsx
//
// Site-wide last line of defence against the BROKEN-IMAGE GLYPH. Renders nothing.
//
// Why this exists (measured 2026-09-06, 510 entity pages in a real 390px Chromium):
//   • 394 of 6,190 NFL All Day edition thumbnails 404 upstream
//     (media.nflallday.com, both image and video — the Genesis Ultimates and a
//     run of 2025 parallels; 44 of them held by real wallets).
//   • Three All Day pack-art URLs point at storage.cloud.google.com, a console
//     URL that redirects to a Google sign-in; the CSP blocks it anyway.
//   • Golazos pack art with a dead `_v0` path; an `.mp4` in an `image_url`.
//   Every one rendered as the browser's broken-image icon inside an otherwise
//   healthy card. Nothing reports it: it is client-only, Sentry is dark (#34),
//   and jsdom cannot see a box.
//
// Why not fix it per component: ~60 `<img>` sites render edition/pack art and
// only two (PackThumb, IpfsThumb) carry an onError. Worse, an onError attached
// by React is USELESS for a server-rendered image whose load already failed
// before hydration — the event has fired and gone. The DOM keeps the verdict
// though: `complete && naturalWidth === 0` is the browser saying "I tried and
// failed" (⚠ `naturalWidth === 0` ALONE means "not requested yet" on a lazy
// image — see headless-qa-fails-toward-false-positives; `complete` is the
// load-bearing half of the test).
//
// So this does two things, once, at the document level:
//   1. On mount, sweep every <img> that has ALREADY failed and neutralise it.
//   2. Install ONE capturing `error` listener on `document` (error events do
//      not bubble, but they do capture) so every future failure — including
//      images mounted later by client navigation — is neutralised as it fails.
//
// "Neutralise" = swap the src for a transparent pixel so the glyph disappears
// and the tile's own background shows through, and mark the element with
// `data-rpc-dead-art` so CSS / QA can find it. Components with their own
// onError still run theirs (PackThumb removes the img entirely; IpfsThumb
// remounts with a new key to retry a cold-cache 502 — a remounted <img> is a
// new element with a fresh load, so the retry is unaffected).
//
// Never applied to: `data:`/`blob:` sources (the pixel itself, canvases), or
// images that opted out with `data-rpc-keep-broken`.

import { useEffect } from "react"

export const DEAD_ART_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"

export function neutraliseDeadImage(img: HTMLImageElement): boolean {
  if (img.dataset.rpcDeadArt === "1") return false
  if (img.hasAttribute("data-rpc-keep-broken")) return false
  const src = img.getAttribute("src") || ""
  if (!src || src.startsWith("data:") || src.startsWith("blob:")) return false
  img.dataset.rpcDeadArt = "1"
  img.dataset.rpcDeadSrc = src.slice(0, 200)
  img.removeAttribute("srcset")
  img.setAttribute("src", DEAD_ART_PIXEL)
  img.style.objectFit = "contain"
  return true
}

export function sweepDeadImages(root: ParentNode = document): number {
  let n = 0
  for (const img of Array.from(root.querySelectorAll("img"))) {
    if (img.complete && img.naturalWidth === 0 && neutraliseDeadImage(img)) n++
  }
  return n
}

export default function DeadImageGuard() {
  useEffect(() => {
    const onError = (e: Event) => {
      const t = e.target
      if (t instanceof HTMLImageElement) neutraliseDeadImage(t)
    }
    document.addEventListener("error", onError, true)
    // Images that failed before hydration have no event left to catch.
    sweepDeadImages()
    // A second pass after the first paint settles catches lazy images that
    // completed (and failed) between hydration and now with their error
    // event already consumed by nothing.
    const t = window.setTimeout(() => sweepDeadImages(), 2500)
    return () => {
      document.removeEventListener("error", onError, true)
      window.clearTimeout(t)
    }
  }, [])
  return null
}
