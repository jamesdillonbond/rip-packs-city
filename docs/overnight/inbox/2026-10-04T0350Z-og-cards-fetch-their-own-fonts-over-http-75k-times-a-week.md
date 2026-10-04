# OG cards fetch their own brand fonts over HTTP ~75,000 times a week (5.5 GB of self-traffic)

*Filed 2026-10-03 ~8:50 PM PT by Claude Code (cloud), found while measuring the IPFS-art egress (inbox 2026-09-13T1708Z). **MEASURED, NOT SHIPPED** — the fix has a silent failure mode that only a production render can rule out; see "Why not shipped".*

## The measurement (Vercel observability, `incoming_request`, week of 2026-09-27 → 10-03)

| route | egress | requests | client |
|---|---|---|---|
| `/fonts/BarlowCondensed-Black.ttf` (110,828 B) | 3.84 GB/week (3.36 the week before) | **75,140 `node` HIT** + 667 `node` MISS + ~520 `Vercel Edge Functions` | our own server |
| `/fonts/ShareTechMono-Regular.ttf` (43,272 B) | 1.66 GB/week (1.45 before) | same shape | our own server |

These are the #3 and #6 egress lines on the whole site, and **essentially none of it is a browser**: the user agent is `node`, i.e. our own lambdas. `lib/og/brand-fonts.ts` `loadBrandFontBytes()` fetches `${BASE_URL}/fonts/*.ttf` (memoised per module instance, so once per COLD START of each of the ~43 `/api/og/**` functions), and `app/api/profile/trophy-case/pdf/route.tsx:376-377` does the same per PDF. Traffic arrives in bursts of ~600–1,300 an hour (crawler unfurl waves → cold OG lambdas).

## Cost today

Small in money: ~5.5 GB/week is well inside Pro's included Fast Data Transfer. The real cost is **latency on the path that decides whether a shared link gets a preview**: every cold OG render first makes two HTTP round trips to our own CDN (bounded at 5 s by `FONT_FETCH_TIMEOUT_MS`) before satori can start. X's crawler gives up on a slow image (the module's own header says so).

## The fix, specified

Bundle the bytes into the function instead of fetching them:

- **Node-runtime routes:** `readFile(join(process.cwd(), "public/fonts/<file>"))`, plus `outputFileTracingIncludes` in `next.config` naming `public/fonts/*.ttf` for `/api/og/**` and `/api/profile/trophy-case/pdf` (Vercel does not ship `public/` inside a lambda unless it is traced).
- **Edge-runtime routes** (the ~520 `Vercel Edge Functions` requests): `fetch(new URL("../../public/fonts/<file>", import.meta.url))`, which Next bundles as an asset.
- Keep `isSupportedFontBuffer` validation and the fail-soft `null` exactly as they are.

## Why not shipped (on purpose)

The loader is **fail-soft by design**: if the bundled path is wrong on Vercel, every card silently renders in `system-ui`, and nothing reds. Not the unit suite, not `tsc`, not a green deploy (CLAUDE.md: *a green suite is not a deploy gate*; the font module's own header records two prior incidents of exactly this class). Shipping it needs a **production read-back**: render one card on a preview deploy and compare its bytes against a fonts-off render (the method in `__tests__/api-og-profile-brand-fonts.test.ts`). That needs a preview URL and an interactive check, not a late-evening push.

## Falsifier / read-back after a fix

`vercel.request.count` for `route eq '/fonts/BarlowCondensed-Black.ttf'` with `client_user_agent eq 'node'` drops to ~0 within a day of the deploy, AND a production OG card's PNG bytes still differ from a fonts-off render.
