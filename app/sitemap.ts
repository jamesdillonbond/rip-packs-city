import type { MetadataRoute } from 'next'

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://rip-packs-city.vercel.app'

export default function sitemap(): MetadataRoute.Sitemap {
  const collections = ['nba-top-shot', 'nfl-all-day', 'laliga-golazos']
  const pages = ['overview', 'collection', 'packs', 'sniper', 'badges', 'sets', 'analytics']

  const staticPages: MetadataRoute.Sitemap = [
    { url: BASE_URL, lastModified: new Date(), changeFrequency: 'daily', priority: 1.0 },
  ]

  const featurePages: MetadataRoute.Sitemap = collections.flatMap(col => [
    { url: `${BASE_URL}/${col}`, lastModified: new Date(), changeFrequency: 'daily', priority: 0.9 },
    ...pages.map(page => ({
      url: `${BASE_URL}/${col}/${page}`,
      lastModified: new Date(),
      changeFrequency: 'hourly' as const,
      priority: 0.8,
    })),
  ])

  return [...staticPages, ...featurePages]
}
