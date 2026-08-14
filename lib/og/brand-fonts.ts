// lib/og/brand-fonts.ts
//
// Brand typography + cache policy for every OG card.
//
// WHY. Barlow Condensed Black and Share Tech Mono have been vendored under
// `public/fonts` (OFL) since the trophy-case PDF shipped, and until 2026-08-13
// that PDF — a file a handful of people download — was their ONLY consumer.
// All 43 `/api/og/**` cards, the images every shared link actually renders on
// X, Discord, Slack and iMessage, drew in `system-ui`/`sans-serif`. The profile
// card was branded first; this module lifts that loader out so the rest of the
// family can be, without 43 copies of a routine whose failure modes have
// already cost this repo two separate incidents.
//
// ⚠ THE TWO THINGS THAT MADE THIS HARDER THAN IT LOOKS, both learned the same
// day and both now encoded here rather than left to be rediscovered:
//
// 1. `public/fonts/*.ttf` was BEHIND THE AUTH WALL. `proxy.ts`'s static-asset
//    bypass did not cover `/fonts/`, so the fetch returned the SSO/login HTML
//    with a perfectly good `200`. The first branded card was therefore BROKEN,
//    not de-branded — satori was handed an HTML document. Fixed in proxy.ts
//    (`FONT_ASSET_RX`); this loader defends against the class regardless by
//    validating the BYTES via `isSupportedFontBuffer`, because `res.ok` and
//    `byteLength > 0` are both true of an error page.
//
// 2. A `try/catch` AROUND `new ImageResponse(...)` CANNOT CATCH A FONT ERROR.
//    The constructor returns a Response whose body is a STREAM, so satori runs
//    when the body is consumed — after the route handler has already returned.
//    A bad font throws past every `catch` in the handler. This is why the
//    validation has to happen HERE, before the bytes reach the renderer, and
//    why a fallback render that re-uses the same fonts is not a safety net.
//
// ⚠ A TEST THAT ONLY ASSERTS "A PNG CAME OUT" CANNOT SEE A FONT REGRESSION.
// Because the loader is fail-soft, a card with it stubbed to null still renders
// perfectly. Assert the rendered BYTES DIFFER between fonts-on and fonts-off.
// (Learned by shipping the vacuous version first; see
// __tests__/api-og-profile-brand-fonts.test.ts.)

import { isSupportedFontBuffer } from "@/lib/og/font-bytes";

const BASE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.rippackscity.com";

export const DISPLAY_FONT = "Barlow Condensed";
export const MONO_FONT = "Share Tech Mono";

export type OgFont = {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 900;
  style: "normal";
};

/**
 * Long-cache policy for a rendered card.
 *
 * ⚠ 42 of 43 cards shipped with NO Cache-Control at all, on `force-dynamic`
 * routes — so every crawler fetch re-ran a satori render plus its DB reads.
 * That is not merely wasteful: X's crawler gives up on a slow image, and a card
 * that renders too late is a link with no preview. An hour of shared cache with
 * a day of stale-while-revalidate keeps unfurls instant and still lets a board
 * move within a day.
 */
export const OG_CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
} as const;

let fontsPromise: Promise<ArrayBuffer[] | null> | null = null;

function loadBrandFontBytes(): Promise<ArrayBuffer[] | null> {
  if (!fontsPromise) {
    fontsPromise = (async () => {
      try {
        const files = [
          `${BASE_URL}/fonts/BarlowCondensed-Black.ttf`,
          `${BASE_URL}/fonts/ShareTechMono-Regular.ttf`,
        ];
        const res = await Promise.all(files.map((u) => fetch(u)));
        if (res.some((r) => !r.ok)) return null;
        const bufs = await Promise.all(res.map((r) => r.arrayBuffer()));
        // Validate the bytes, not the response — see (1) and (2) above.
        return bufs.every(isSupportedFontBuffer) ? bufs : null;
      } catch {
        return null;
      }
    })();
  }
  return fontsPromise;
}

/**
 * Fonts for `new ImageResponse(..., { ...opts })`, or `undefined` when they
 * could not be fetched or did not validate. Memoized at module scope, so a warm
 * invocation pays the fetch once.
 */
export async function brandFonts(): Promise<OgFont[] | undefined> {
  const bufs = await loadBrandFontBytes();
  if (!bufs) return undefined;
  const [display, mono] = bufs;
  return [
    { name: DISPLAY_FONT, data: display, weight: 900, style: "normal" },
    { name: MONO_FONT, data: mono, weight: 400, style: "normal" },
  ];
}

/**
 * The font-family strings a card should use for a given load result, so a route
 * never writes the `fonts ? BRAND : "sans-serif"` ternary itself — the spot
 * where a card silently keeps its generic face after being "converted".
 */
export function brandFamilies(fonts: OgFont[] | undefined) {
  return {
    display: fonts ? DISPLAY_FONT : "sans-serif",
    mono: fonts ? MONO_FONT : "sans-serif",
  };
}

/** Test-only: drop the module-scope memo between cases. */
export function _resetBrandFontsForTest(): void {
  fontsPromise = null;
}
