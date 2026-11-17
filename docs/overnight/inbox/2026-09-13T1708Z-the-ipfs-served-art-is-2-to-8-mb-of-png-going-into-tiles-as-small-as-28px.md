# The IPFS-served art is 2–8 MB of PNG going into tiles as small as 28px

**Filed:** 2026-09-13 ~10:08 PT (Claude Code, cloud) · **READ-ONLY — nothing shipped, and the one number that would decide it is NOT measured (see §4).**

Found while verifying the raw-gateway render fix shipped the same hour (`121b17b2a`). That fix routes every Moment thumbnail through `/api/public/ipfs-media/<cid>`. This filing is about what that proxy then streams.

## 1 · The sizes, measured

Five pre-2022 Top Shot editions sampled by `abs(hashtext(url||salt)) % 991` (not a `LIMIT` off physical order), probed `Range: bytes=0-0` from the database's egress and read off `content-range`:

| # | bytes |
|---|---|
| 1 | 3,708,888 |
| 2 | 2,187,989 |
| 3 | 4,150,543 |
| 4 | 4,785,177 |
| 5 | **7,649,266** |

Median ≈ **4.15 MB**, and a sixth sample from UFC Strike measured **3,698,448**. ⚠ **n=6. This is a SAMPLE, not a census** — but there is no small one in it.

## 2 · The population and the mechanism

**2,886 editions** store a public-gateway url (`nba_top_shot` **2,368** on `ipfs.dapperlabs.com`, `ufc_strike` **518** on `ipfs.io` — live counts, same day). Our proxy **streams the upstream bytes through unchanged**: it races gateways, sets `public, max-age=86400, s-maxage=31536000, immutable`, and does no resizing. So a surface rendering `<img src="/api/public/ipfs-media/<cid>">` paints a multi-megabyte master into whatever slot it has — **28px** in the global-search dropdown, **52px** on sold-moment rows, **130px** on a six-up trophy slab.

⛔ **This is PRE-EXISTING, not something today's fix introduced.** The nine surfaces that already called `proxyIpfsUrl` have always done this; today's change moved thirteen more from a *broken* tile (raw `ipfs.io`, which times out) to a *heavy* one. **Strictly better, and worth saying in the same breath as the cost.**

## 3 · The lever, which this repo already owns

`/_next/image?url=/api/public/ipfs-media/<cid>&w=<slot>&q=75`. It is the exact leg `ogOptimizedTarget` uses for the OG cards, it is already proven on the LOCAL path (our own urls are handed over site-relative so they match `localPatterns` rather than `remotePatterns`), and it turned a 7,677,876 B Ultimate into **119,162 B** — 64×. Against the median above that is roughly **4 MB → ~100 KB per tile**.

## 4 · ⛔ WHY THIS IS FILED AND NOT SHIPPED — the number that decides it is not measured

**How often do these tiles actually render?** An eligibility count is not a usage count, and this register keeps paying for that confusion.

- **2,886 editions can carry such a url. That is not 2,886 renders.** Top Shot's collection grid routes through `/api/moment-thumbnail` (a Top Shot CDN resource keyed on the moment id), *not* the stored thumbnail, so the big IPFS masters appear only on the surfaces that read `thumbnail_url` directly — edition detail, trophy slabs, search, sold-moment rows.
- **Every transformation is metered** (#95: the ceiling is ≈14,469 and the actual bill was **$0.00 against 16 transformations** in the closed cycle). Routing these through the optimizer ADDS keys to that ceiling; the trade is optimizer spend against bandwidth, and **nobody has measured which side is bigger here.**

👉 **What to measure before shipping it:** the Vercel bandwidth attributable to `/api/public/ipfs-media/` over a week, against the transformation count a `w=` per slot would add. Both are one dashboard read for someone with Vercel egress; this sandbox has none.

## 5 · If it does get shipped, two things that will bite

1. ⚠ **A width per SLOT, not one global width.** `w` must be a member of `images.deviceSizes ∪ imageSizes` or the optimizer answers **400**, and `q` must be in `images.qualities` (defaults `[75]`). Both are pinned against the installed Next config in `__tests__/og-img-data.test.ts` — read them from there rather than restating them.
2. ⛔ **Do not "fix" this by teaching the ipfs-media proxy to resize.** It streams; adding a resize stage puts CPU on the request a crawler is waiting on, and the platform already has an optimizer that caches derivatives. The proxy's job is reachability, not geometry.

## ✅ MEASURED AND SHIPPED 2026-10-03 ~8:40 PM PT (Claude Code cloud)

**The deciding number, from Vercel observability (`vercel.request.fdt_out_bytes` by route):** `/api/public/ipfs-media/[cid]` served **18.1 GB** (week of 09-21) and **21.3 GB** (week of 09-28), the site's largest egress line by far. That is ≈ 6,200 requests a week at ~3.4 MB each, 99 % non-bot (`bot_name` empty). The resizing route `/api/public/ipfs-thumb/[cid]` (shipped 09-29 for known-issues #162, `222f65ceb`) served 48 MB. `/_next/image` served 51 MB. **Bandwidth wins by three orders of magnitude**, and the resizer is our own sharp route, not the metered optimizer, so the #95 transformation ceiling does not apply.

**Who was still pulling originals:** referrers were Top Shot team pages, `/nba-top-shot/sniper` and `/market`, `/insights/trophies`, `/insights/rookies` and edition pages. The 09-29 sweep converted 44 sites and left four image sites on the original: `TeamChecklist` tiles, `TrophySlab` (`<img>` + video `poster`), `MomentMedia.getImageUrl` (market/sniper rows, the moment modal) and `CollectionProfileClient.thumbnailSrc`. All four now use `proxyIpfsImageUrl(url, 640)`; videos stay on `proxyIpfsUrl`. **New guard** `__tests__/ipfs-images-use-the-resizer-not-the-original.test.ts`: a tree-walk ban at zero, under which every `proxyIpfsUrl(` outside `lib/ipfs-media.ts` must name a video (planted defect, the old `MomentMedia` line, caught).

**Falsifier / read-back:** over the week after the deploy, `/api/public/ipfs-media/[cid]` egress should fall well below 21 GB, with `ipfs-thumb` rising. If ipfs-media stays near 20 GB, the remaining traffic has no referrer (11.9 GB of the 09-27→10-03 window had an EMPTY referrer: direct loads, apps or OG scrapers), and that slice needs its own attribution.
