# The image-weight finding is REAL and bigger than filed — but **90% of it is `assets.nbatopshot.com`, not our proxy** — and the free 190× lever destroys transparency

*Claude Code, Trevor's box · MEASUREMENT, three falsifiers discharged, nothing shipped · 2026-09-05 07:00 PT*

Extends and **corrects** inbox `2026-09-05T1235Z` ("2,334 editions serve multi-MB PNGs… and the proxy that could fix it is ours"). That filing named three falsifiers and asked for them to be run before anything is built. All three are now run. **The finding survives, its magnitude is smaller, its LOCATION is different, and the obvious fix is not free.**

## Falsifier 1 — survives, with a magnitude correction

> *"If a wider sample of the 2,334 comes back mostly under ~1 MB, the 8-of-8 sample was unlucky."*

**40 CIDs drawn pseudo-randomly** (`abs(hashtext(id)) % 100 < 3`, not a `LIMIT` — physical order clusters on recent writes), 39 sized:

```
min 1.79 MB   p25 3.08   MEDIAN 3.55   p75 4.48   max 5.49 MB   mean 3.75 MB
under 1 MB: 0 / 39      over 2 MB: 37 / 39      content-type: image/png 39/39
```

⭐ **The falsifier's condition is decisively not met — 0 of 39 under 1 MB.** ⚠ But the original **mean of ~5.1 MB overstated it by ~36%** (true 3.75 MB) and its 7.65 MB max is above anything in the wider sample (5.49 MB). Direction unchanged, size smaller.

## Falsifier 2 — discharged, no transform anywhere

> *"If `/api/public/ipfs-media` is fronted by a CDN transform… check a warmed edge response."*

Same CID, three ways: direct gateway **1,881,398 b** · our proxy cold (`x-vercel-cache: MISS`) **1,881,398 b** · our proxy **warm (`HIT`) 1,881,398 b**. Byte-identical warm and cold. **Nothing resizes.**

## 🚨 Falsifier 3 — answered, and it RELOCATES the problem

> *"The wallet and collection grids were NOT measured and are the ones most likely to show many at once."*

Measured in a real browser at **390 × 844, dpr 2** (a mid-range phone), counting **bytes actually transferred**, not tile-count × mean size:

| page | tiles | on load | after 3 screens |
|---|---|---|---|
| **`/insights/trophies`** | 205 imgs (43 proxy) | **75.06 MB** | **135.12 MB** |
| `/nba-top-shot/set/heat-check` | 67 imgs (**0** proxy) | 0.51 MB | 0.51 MB |
| `/nba-top-shot/set/fit-check` | 107 imgs (**0** proxy) | 0.38 MB | 0.38 MB |

⛔ **AND THE WEIGHT IS NOT WHERE THE FILING PUT IT.** Broken down by host on that 75.06 MB:

| host | responses | MB | share |
|---|---|---|---|
| **`assets.nbatopshot.com`** | 11 | **67.58** | **90.0%** |
| `www.rippackscity.com` (our IPFS proxy) | 4 | 7.26 | 9.7% |
| `media.nflallday.com` | 6 | 0.22 | 0.3% |

`content-length` was present on **11 of 11** of the CDN responses, so this is not a body-read artifact. Largest single response: **7.59 MB PNG**. Every tile on the page renders at **165 CSS px** (330 device px at dpr 2).

⭐ **So the filing's lever — a resize in the proxy we own — addresses about 10% of the weight.** The dominant cost is a host we do not own, reached by a plain `<img>`.

⚠ **The filing's CDN "control" is also not what these pages request.** It measured `assets.nbatopshot.com/media/52547718?type=hero` at 837 KB and read that as the cheap comparison; the trophies page actually requests `…/editions/<set>/<uuid>/play_…_capture_Hero_2880_2880_Transparent.png`, whose dimensions are in the filename.

## ⛔ And MY OWN prediction was wrong, which is worth recording

I picked the worst-case page from the database — `Heat Check`, **60 of 60** editions carrying an `ipfs.dapperlabs.com` thumbnail — and predicted it would be the heaviest surface. **Measured, it requests ZERO proxy tiles and moves 0.51 MB.** Same for `Fit Check` (86 IPFS thumbnails in the data, 0 on the page).

⭐ **`editions.thumbnail_url` does not predict what a page renders.** A set page evidently resolves its art some other way. Choosing which page to load from a column that surfaces may not use is the same class of error as sampling where the answer cannot vary — **load the page before believing the query.**

## ⭐ A free 190× lever exists… and ⛔ it flattens transparency

The CDN serves its own sized variants, and **this codebase already uses that form at 8 call sites** (`app/api/moment-thumbnail`, `wallet-search`, `serial-premiums`, the edition page, …). Same asset:

| form | bytes | type |
|---|---|---|
| raw `…_2880_2880_Transparent.png` | **7,130,685** | image/png |
| `/media/<id>/image` | 593,964 | image/jpeg |
| `/media/<id>/image?width=400` | **37,570** | image/jpeg |
| `/media/<id>/image?width=400&format=webp` | **25,486** | image/webp |

**190× smaller at `width=400`, 280× as webp**, for a tile displayed at 165 CSS px. No Vercel image transforms, so **no metered spend** — which matters, because `next/image` (the other obvious route) bills per transformation and CLAUDE.md holds infra spend at zero pre-revenue.

🚨 **BUT IT IS NOT A PURE WIN, AND THIS IS THE PART TO READ.** Checked at the container level rather than assumed:

- The source PNG's IHDR **colour-type is 6 — RGBA. It genuinely carries alpha.**
- The CDN's webp output is **lossy `VP8 `, with no alpha chunk**; `?format=png` is **ignored** and returns JPEG.
- Sampling the decoded corner pixel: source = transparent, sized = **`[0,0,0,255]` — opaque black.** The CDN flattens onto black.

⚠ **`MomentMedia`'s default background is `rgba(255,255,255,0.05)`** — a wash over the *theme-aware* page background. Flattening onto black is invisible in dark mode and renders **a black slab in light mode**, which is the exact failure CLAUDE.md already records for hardcoded dark fills. ⓘ Note the page **already mixes both forms** (some tiles are served `/media/<id>/image?width=400` today), so the flattening is already shipping somewhere — that is an argument it may be acceptable, **not** evidence that it is.

## What I did NOT do

⛔ **Nothing shipped.** The lever is a change to `components/MomentMedia.tsx`, which is shared across many surfaces, and the alpha question is a **visual-fidelity product call** — not something to decide autonomously at 07:00. ⛔ Nor did I switch to `next/image`: it would work (`assets.nbatopshot.com` is already in `remotePatterns`) but bills per transformation.

## The decision, stated so it can be made in one sitting

1. **Is losing transparency acceptable on Moment tiles?** If yes, the fix is cheap, free of infra cost, and 190×. Check light mode explicitly.
2. If no, the options are `next/image` (metered) or a resize in our own proxy — which covers only the 10%.
3. Either way, **`/insights/trophies` is the surface to fix**; the set pages measured are already fine.

---

## ADDENDUM — the two obvious "surely there's a free way" follow-ups are both REFUTED

Before anyone re-tries them: the alpha-preserving escapes do not exist on this CDN.

**1. Size parameters on the RAW path are IGNORED — not rejected, ignored.**

```
…_2880_2880_Transparent.png?width=400              200  7,130,685 b  image/png
…_2880_2880_Transparent.png?w=400                  200  7,130,685 b  image/png
…_2880_2880_Transparent.png?width=400&format=webp  200  7,130,685 b  image/png
```

⚠ **Every one returns HTTP 200 with the full 6.8 MB payload.** That is the dangerous shape: a `?width=` that 404'd would announce itself, whereas this looks like it worked. `/editions/<set>/<uuid>/…png` is a plain object store; only `/media/<id>/image` is a transform endpoint.

**2. Dapper does not publish smaller variants at a predictable path.** The filename encodes its dimensions (`_2880_2880_`), which invites substitution — it does not work:

```
…_512_512_Transparent.png    404
…_400_400_Transparent.png    404
…_256_256_Transparent.png    404
…_640_640_Transparent.png    404
…_1080_1080_Transparent.png  404
```

⭐ **So there is no alpha-preserving cheap path.** The `/media/<id>/image` transform is the only CDN-side lever, and it flattens to black. That makes the decision above genuinely a decision — not a search for a cleverer URL — and it is the reason this was filed rather than shipped.

ⓘ One consequence worth stating: because the raw path **ignores** unknown query parameters and returns 200, any future "add `?width=` and measure" attempt will look successful in a status-code check and change nothing. **Measure the BYTES, not the status.**
