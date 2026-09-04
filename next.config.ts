import type { NextConfig } from "next"
import { withSentryConfig } from "@sentry/nextjs"

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      // Top Shot — primary CDN + the preview/thumbnail host used by pack OG cards
      { protocol: "https", hostname: "assets.nbatopshot.com", pathname: "/**" },
      { protocol: "https", hostname: "asset-preview.nbatopshot.com", pathname: "/**" },
      // NFL All Day
      { protocol: "https", hostname: "media.nflallday.com", pathname: "/**" },
      // LaLiga Golazos
      { protocol: "https", hostname: "assets.laligagolazos.com", pathname: "/**" },
      // IPFS gateways used for older Pinnacle / UFC artifacts
      { protocol: "https", hostname: "ipfs.io", pathname: "/**" },
      { protocol: "https", hostname: "gateway.pinata.cloud", pathname: "/**" },
    ],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com",
              "img-src 'self' data: blob: https:",
              "connect-src 'self' https: wss:",
              "frame-src 'self' https:",
              "media-src 'self' https:",
            ].join("; "),
          },
        ],
      },
    ]
  },
  async redirects() {
    return [
      // Canonical-host redirect (2026-07-20): the bare production alias
      // rip-packs-city.vercel.app served the full site alongside the apex,
      // diluting SEO with duplicate content. 308 every path on that host to the
      // canonical www domain. Scoped by Host header, so the real domain and the
      // hashed preview deploy URLs are untouched.
      {
        source: "/:path*",
        has: [{ type: "host", value: "rip-packs-city.vercel.app" }],
        destination: "https://www.rippackscity.com/:path*",
        permanent: true,
      },
      { source: "/wallet",  destination: "/nba-top-shot/collection", permanent: false },
      { source: "/packs",   destination: "/nba-top-shot/packs",      permanent: false },
      { source: "/sniper",  destination: "/nba-top-shot/sniper",     permanent: false },
      { source: "/sets",    destination: "/nba-top-shot/sets",       permanent: false },
      { source: "/undefined/:path*", destination: "/nba-top-shot/:path*", permanent: false },
      // 2026-09-03: the public trophy case lives at /profile/<u>/trophy-case, but
      // the short form /trophy-case/<u> is what people type and share; it used
      // to fall through to the auth gate and 307 to /login. Alias, not a page.
      { source: "/trophy-case/:username", destination: "/profile/:username/trophy-case", permanent: false },
      // Audit 2026-05-20 (F7): canonical UFC route is /ufc; /ufc-strike rendered a broken hybrid.
      { source: "/ufc-strike/:path*", destination: "/ufc/:path*", permanent: true },
      // 2026-07-25: `pinnacle` is NOT a registered collection slug (the
      // canonical one is `disney-pinnacle`), but the dynamic
      // app/(collections)/[collection]/* tree still matched /pinnacle/<tab>
      // because app/pinnacle/ only defines `page` + `moment/[id]`. The result:
      // /pinnacle/overview|collection|market rendered real Disney Pinnacle data
      // under NBA Top Shot chrome — getCollection("pinnacle") returns undefined,
      // so the segment layout fell back to the first published collection for
      // the header/pill/breadcrumb while the pages fetched by the raw slug.
      // Redirect the feature tabs + entity routes to the canonical slug.
      // DELIBERATELY NOT a blanket /pinnacle/:path* rule: /pinnacle/moment/<render_id>
      // is a real, working, sitemap'd surface (~2,412 URLs, lib/sitemap-data.ts
      // segment 4) and must keep resolving. Hence the explicit page allowlist.
      // Bare tab first: the `/:rest*` rule below compiles an empty `rest` to a
      // TRAILING SLASH ("/disney-pinnacle/overview/"), which then needs a second
      // 308 to drop it. Matching the no-sub-path case here makes it one hop.
      {
        source:
          "/pinnacle/:page(overview|collection|market|sniper|analytics|sets|packs|pack-sniper|challenges|hot-floors|play|badges)",
        destination: "/disney-pinnacle/:page",
        permanent: true,
      },
      {
        source:
          "/pinnacle/:page(overview|collection|market|sniper|analytics|sets|packs|pack-sniper|challenges|hot-floors|play|badges|edition|set|series|player|team|pack|profile)/:rest+",
        destination: "/disney-pinnacle/:page/:rest+",
        permanent: true,
      },
      // 2026-07-25: the REVERSE hop for moments only, closing the dead end left by
      // the deliberate asymmetry above. /disney-pinnacle/moment/<render_id> is the
      // shape a developer or crawler guesses from the canonical collection slug,
      // but the dynamic [collection]/moment resolver forwards to /moment/<id>,
      // whose get_moment_detail resolver only knows pinnacle_editions.id — NOT the
      // pinnacle_catalog.render_id these urls carry (verified: render_id
      // GEN-DPIN-SIMB-S0 has 1 row in pinnacle_catalog, 0 in pinnacle_editions).
      // So it dead-ended on a not-found page. Only /pinnacle/moment/<id> reads
      // pinnacle_catalog, so send the guessable url there.
      //
      // Direction chosen deliberately: /pinnacle/moment/* is the canonical
      // surface. It ships ~2,412 sitemap urls (lib/sitemap-data.ts segment 4) and
      // the page self-canonicals to /pinnacle/moment/<render_id>, so redirecting
      // the other way would churn every indexed url and contradict its own
      // canonical tag. This way those 2,412 stay untouched 200s.
      //
      // No loop: `moment` is deliberately absent from BOTH /pinnacle/:page
      // allowlists above, so the destination is never re-matched. next.config
      // redirects also run BEFORE the proxy.ts auth gate (verified live:
      // /pinnacle/overview 308s cleanly instead of bouncing to /login), so an
      // anonymous crawler gets one hop straight to the rendered page.
      {
        source: "/disney-pinnacle/moment/:id",
        destination: "/pinnacle/moment/:id",
        permanent: true,
      },
      // Audit 2026-05-20 (F17): panini-blockchain is unpublished + off-platform; neutralize the dead route.
      { source: "/panini-blockchain/:path*", destination: "/nba-top-shot/overview", permanent: false },
      // ⛔ REMOVED 2026-08-29 (register R36): `/profile` → `/dashboard` was a
      // PERMANENT redirect into an auth-gated page, so the leftmost mobile tab
      // sent every anonymous first-run visitor `/profile` → 308 → `/dashboard`
      // → 307 → `/login`. `app/profile/page.tsx` now serves that path and does
      // the signed-in redirect ITSELF, on the server — see the header there for
      // why fixing the destination is safe where fixing the nav was not.
      // ⚠ It was `permanent: true` (308), which browsers and crawlers CACHE.
      // Anyone who hit it before this ships may keep skipping the new page until
      // that cache expires; the page is correct for them the moment it does.
    ]
  },
}

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "rip-packs-city",

  project: "javascript-nextjs",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Uncomment to route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  // tunnelRoute: "/monitoring",

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
});
