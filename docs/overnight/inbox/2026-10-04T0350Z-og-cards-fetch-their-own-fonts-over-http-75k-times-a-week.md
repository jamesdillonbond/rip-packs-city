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

## ✅ SHIPPED 2026-10-04 ~6:15 AM PT (Claude Code cloud) — in a shape that cannot regress

The "why not shipped" risk was removed rather than accepted. `lib/og/brand-fonts.ts` now reads `public/fonts/*.ttf` from the function's own disk on `NEXT_RUNTIME === "nodejs"`. **The HTTP fetch stays as the FALLBACK**, so a wrong path or an untraced file behaves exactly as before; it can never fall to `system-ui`. The bytes are validated the same way. `next.config.ts` `outputFileTracingIncludes` ships both files into `/api/og/**`. The 7 edge cards keep HTTP (~520/week).

**Pre-push proof (local `next build` + `next start`, Node 24):**
- All **38/38** Node OG function traces (`route.js.nft.json`) carry both fonts.
- No edge bundle contains `node:fs`, and there are 0 "Node.js module in Edge Runtime" warnings.
- With a preload spy on `globalThis.fetch`, rendering `/api/og/insights` logged **0** `/fonts/` requests. Positive control: the same spy saw the card's 44 data fetches. The PNG renders in Barlow Condensed + Share Tech Mono.

**Still open (the falsifier above):** `vercel.request.count` for `/fonts/BarlowCondensed-Black.ttf` with `client_user_agent eq 'node'` should fall from ~10k/day to roughly the edge share within a day. The trophy-case PDF route still fetches over HTTP (low volume, not changed).

## ⛔ CORRECTION 2026-10-04 ~6:40 AM PT — the source was misattributed. It was our TEST SUITE, not our lambdas

The read-back's positive control failed. Each new deploy drew ~150 `node` font requests against only ~8 `/api/og/*` requests. Splitting the font requests by `asn_name` (Vercel observability, week of 9-28, Barlow face):

| source (asn) | requests | what it is |
|---|---|---|
| Microsoft Corporation | **71,316** | GitHub Actions runners — CI's vitest |
| CenturyLink | 3,413 | a residential box running the suite |
| Google LLC | 1,568 | cloud sandboxes running the suite |
| Amazon (`node`) | **958** | our Node OG lambdas (what the 6:15 change addresses) |
| Amazon (edge UA) | 504 | the edge cards |

**~98% was vitest.** Every test that renders an OG card called `brandFonts()`, whose HTTP path fetched `https://www.rippackscity.com/fonts/*.ttf` (it is not stubbed in most suites). Measured locally with a fetch spy: one run of the OG-related test files made **312 requests to production** (156 per face). That matches the ~160-per-CI-run bursts, which landed right after each push and so read as "post-deploy".

**Fixed:** `vitest.setup.ts` sets `NEXT_RUNTIME ||= "nodejs"`, so tests take the loader's disk path (`public/fonts` in the checkout). The two files that test the HTTP path opt out with `vi.stubEnv("NEXT_RUNTIME", "")`. The empty string is deliberate: `"edge"` also switches `next/og` to a wasm build that cannot load under Node. Re-measured: **0** font fetches across the 80 OG-related test files (1,394 tests green). This also removes the suite's dependency on the live site (the 2026-08-29 render-sweep hang was this fetch).

The lambda change (6:15 AM PT) stays. It is correct and removes the remaining ~1k/week plus two round trips per cold Node card render. It just was not the 75k.

**Falsifier now:** `asn_name eq 'Microsoft Corporation'` `node` requests for `/fonts/*.ttf` fall from ~10k/day to ~0 once CI runs on the new setup.

**Lesson:** a user agent of `node` names a RUNTIME, not a caller. Before attributing self-traffic to our servers, split by `asn_name` (AWS = our functions; Microsoft = GitHub runners).
