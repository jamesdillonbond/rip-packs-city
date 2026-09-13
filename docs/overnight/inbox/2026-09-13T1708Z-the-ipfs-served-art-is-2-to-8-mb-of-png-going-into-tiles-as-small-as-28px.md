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
