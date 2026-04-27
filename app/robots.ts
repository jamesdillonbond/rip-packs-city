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

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://rip-packs-city.vercel.app'

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
          '/profile',         // editor — exact match; /profile/* (public profiles) NOT disallowed
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
          '/ufc/',
          '/panini-blockchain/',
        ],
      },
      // Block aggressive AI scraping crawlers from training on our content
      // unless they negotiate. SEO crawlers (Googlebot/Bingbot/etc.) fall
      // under the wildcard '*' rule above.
      { userAgent: 'GPTBot',           disallow: '/' },
      { userAgent: 'ClaudeBot',        disallow: '/' },
      { userAgent: 'CCBot',            disallow: '/' },
      { userAgent: 'anthropic-ai',     disallow: '/' },
      { userAgent: 'Google-Extended',  disallow: '/' },
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
    host: BASE_URL,
  }
}
