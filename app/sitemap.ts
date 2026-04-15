import type { MetadataRoute } from 'next'
import { publishedCollections } from '@/lib/collections'

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://rip-packs-city.vercel.app'

export default function sitemap(): MetadataRoute.Sitemap {
  const staticPages: MetadataRoute.Sitemap = [
    { url: BASE_URL, lastModified: new Date(), changeFrequency: 'daily', priority: 1.0 },
  ]

  const featurePages: MetadataRoute.Sitemap = publishedCollections().flatMap(col => [
    { url: `${BASE_URL}/${col.id}`, lastModified: new Date(), changeFrequency: 'daily', priority: 0.9 },
    ...col.pages.map(page => ({
      url: `${BASE_URL}/${col.id}/${page}`,
      lastModified: new Date(),
      changeFrequency: 'hourly' as const,
      priority: 0.8,
    })),
  ])

  return [...staticPages, ...featurePages]
}
