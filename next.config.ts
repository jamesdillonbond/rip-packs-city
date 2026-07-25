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
      {
        source:
          "/pinnacle/:page(overview|collection|market|sniper|analytics|sets|packs|pack-sniper|challenges|hot-floors|play|badges|edition|set|series|player|team|pack|profile)/:rest*",
        destination: "/disney-pinnacle/:page/:rest*",
        permanent: true,
      },
      // Audit 2026-05-20 (F17): panini-blockchain is unpublished + off-platform; neutralize the dead route.
      { source: "/panini-blockchain/:path*", destination: "/nba-top-shot/overview", permanent: false },
      { source: "/profile", destination: "/dashboard", permanent: true },
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
