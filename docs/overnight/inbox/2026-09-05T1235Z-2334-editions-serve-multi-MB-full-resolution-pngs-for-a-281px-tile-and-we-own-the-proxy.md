# 2,334 Top Shot editions serve 2.6–7.7 MB full-resolution PNGs for a 281 px tile — and the proxy that could fix it is ours

**Filed 2026-09-05 ~12:35Z (05:35 PT) — Cowork, cloud, autonomous night pass (block 5).**
**Nothing shipped** — the lever is a route change (`app/api/public/ipfs-media/[cid]/route.ts`), which
this pass does not ship. ⚠ **Read the "what this is NOT" section before acting**: my first framing of
this was wrong by an order of magnitude and the correction is the useful part.

## The measurement

`editions.thumbnail_url` for Top Shot splits three ways:

| thumbnail host | editions | share |
|---|---|---|
| `assets.nbatopshot.com` (CDN, JPEG) | 11,668 | 56.6% |
| `ipfs.dapperlabs.com` (IPFS, PNG) | **2,334** | **11.3%** |
| NULL | 6,597 | 32.0% |

**Eight random IPFS thumbnails, fetched whole:**

```
4,294,660  5,798,689  3,163,779  2,615,188
3,706,521  5,828,948  7,652,889  7,570,982     all 200, all image/png
```

**2.6 – 7.7 MB, mean ≈ 5.1 MB, 8 of 8.** The CDN control on the same page family:
`assets.nbatopshot.com/media/52547718?type=hero` → **837,245 b, image/jpeg**. So ~**6× heavier**,
and PNG for photographic content.

**Displayed size, measured in a real browser on `/insights/trophies`:** 43 IPFS tiles, **every one
281 CSS px wide** at `devicePixelRatio` 1.25 — about **351 device pixels**. A ~5 MB, full-resolution
PNG is being delivered for a 351 px slot.

## Nothing in the path resizes, and one link in it is ours

- `components/MomentMedia.tsx` renders a plain **`<img>`**, not `next/image`.
- `next.config.ts` `images.remotePatterns` lists `assets.nbatopshot.com`, `asset-preview.nbatopshot.com`,
  `media.nflallday.com`, `assets.laligagolazos.com`, `ipfs.io`, `gateway.pinata.cloud` — **`ipfs.dapperlabs.com`
  is not among them**, so switching that component to `next/image` alone would reject these URLs.
- ⭐ **`/api/public/ipfs-media/[cid]` — which we own, and which these tiles already route through —
  passes the bytes through unchanged.** Verified rather than assumed: the proxy returned
  **5,487,319 b** and the direct gateway fetch returned **5,487,319 b**, byte-for-byte, for the same CID.
  Grepped for `sharp`/`resize`/`width`/`quality` in that route: **no resize logic at all.**

⭐ **That is what makes this actionable without touching Dapper**: the tiles already flow through a
route we control, so a width-parameterised resize + cache there needs no upstream cooperation and no
change to `editions.thumbnail_url`.

## ⛔ What this is NOT — I got this wrong first and the correction is the point

My first read was *"`/insights/trophies` references 43 IPFS CIDs × ~5.1 MB ≈ 220 MB of image
transfer for one public page."* **That arithmetic is wrong as a page-weight claim, and measuring it
in a real browser is what showed why.**

On that page: **205 `<img>` tags — 132 `assets.nbatopshot.com`, 29 `media.nflallday.com`, 43 via our
proxy, 1 local.** Their state after loading and scrolling:

```
painted 1   failed 0   pending 204   lazy 204   in-viewport 8
```

⭐ **Zero failed, and all 204 carry `loading="lazy"`.** The document is **21,918 px** tall and only
**8 tiles** were in the viewport. **The lazy-loading is working exactly as intended** — a visitor pays
only for tiles they actually scroll past, not 220 MB on load. **Nothing on that page is broken.**

⚠ **I also briefly read `painted 0` as "the trophy case renders no art".** It does not mean that; it
means the images had not been requested yet. **`naturalWidth === 0` is only a failure when `complete`
is true** — the same distinction that separates "blank" from "still loading", and I had to measure
`complete` explicitly to tell them apart.

## So what is left, stated at its true size

**Per tile actually scrolled past: ~5 MB for a 351-device-pixel slot, ~6× the CDN equivalent.** That
is a real cost on mobile data and on decode time for a long grid, and it is invisible to every
instrument we have — it is not an error, not a 4xx, not a blank image. It is simply expensive.

**It is not an outage, it is not urgent, and it degrades gracefully.** Filed so the size is known.

## Falsifiers

1. If a wider sample of the 2,334 comes back mostly under ~1 MB, the 8-of-8 sample was unlucky and
   the population claim is wrong. **Sample more before building anything.**
2. If `/api/public/ipfs-media` is fronted by a CDN transform we have not noticed, the byte-identical
   pass-through I measured is a cold-path artifact — check a warmed edge response before concluding
   nothing resizes.
3. If the surfaces that render IPFS-backed tiles are all deep-scroll pages with few tiles above the
   fold, the practical cost is smaller than the per-tile number suggests. I measured only
   `/insights/trophies` (43 tiles) and `/nba-top-shot/set/2023-rookie-ultimates` (10); the wallet and
   collection grids were **not** measured and are the ones most likely to show many at once.
