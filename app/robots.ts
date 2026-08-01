// app/robots.ts
//
// Crawl directives. Mirrored to /robots.txt by Next.js. Spec source:
//   • allow root + every public route
//   • disallow API, _next, the auth callback, the profile editor, the
//     session-only login screen, and any URL containing user-scoped
//     query params (?wallet=, ?owner=, ?owner_key=) so Google doesn't
//     index a blizzard of duplicate per-user permutations of the same
//     page.
//
// When the production domain (rippackscity.com) is live, swap BASE_URL
// to point to it so the sitemap reference is correct.

import type { MetadataRoute } from 'next'

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.rippackscity.com'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/'],
        disallow: [
          '/api/',
          '/_next/',
          '/admin/',
          '/login',
          '/dashboard',       // authed dashboard — private surface
          // NOTE: no bare '/profile' here — robots Disallow is a prefix match,
          // so '/profile' would block '/profile/<username>' (the public
          // profile pages) too. Only the authed editor sub-routes are blocked.
          // The legacy '/profile' editor path 308s to /dashboard (already
          // disallowed), so it needs no separate rule.
          '/profile/edit',
          '/profile/settings',
          '/auth/',
          '/share/',          // share pages are user-scoped one-off renders
          // user-scoped query-param permutations
          '/*?wallet=',
          '/*?owner=',
          '/*?owner_key=',
          '/*?address=',
          // unpublished collection
          '/panini-blockchain/',
        ],
      },
      // AI-crawler blocks REMOVED 2026-08-01 (Trevor). GPTBot / ClaudeBot /
      // CCBot / anthropic-ai / Google-Extended each carried a bare
      // `Disallow: '/'` here, which shut RPC out of every AI answer engine.
      // For a niche tool whose users ask questions in natural language ("what
      // is this moment worth", "which packs are +EV"), answer engines are a
      // PRIMARY discovery channel, not a leak — blocking them was
      // self-sabotage at WAU 0. Those agents now fall under the wildcard '*'
      // rule above, so every path-level Disallow (/api/, /admin/, /dashboard,
      // /share/, the user-scoped query-param permutations, /panini-blockchain/)
      // still applies to them exactly as it does to Googlebot. Re-adding a
      // blanket block is a traffic decision, not a hygiene one — do not
      // reintroduce it without one.
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
    host: BASE_URL,
  }
}
