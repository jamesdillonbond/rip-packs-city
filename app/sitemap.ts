import type { MetadataRoute } from 'next'
import { publishedCollections } from '@/lib/collections'
import { METHODOLOGY_LIST } from '@/lib/analytics/methodology'

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://rip-packs-city.vercel.app'

const ANALYTICS_STUBS = [
  'pulse',
  'sales',
  'listings',
  'wallets',
  'packs',
  'sets',
  'fmv',
  'api',
]

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

  const analyticsPages: MetadataRoute.Sitemap = [
    {
      url: `${BASE_URL}/analytics`,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 0.9,
    },
    {
      url: `${BASE_URL}/analytics/loans`,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 0.9,
    },
    ...ANALYTICS_STUBS.map((slug) => ({
      url: `${BASE_URL}/analytics/${slug}`,
      lastModified: new Date(),
      changeFrequency: 'weekly' as const,
      priority: 0.6,
    })),
    {
      url: `${BASE_URL}/analytics/methodology`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.5,
    },
    ...METHODOLOGY_LIST.map((m) => ({
      url: `${BASE_URL}/analytics/methodology/${m.slug}`,
      lastModified: new Date(),
      changeFrequency: 'monthly' as const,
      priority: 0.5,
    })),
  ]

  return [...staticPages, ...featurePages, ...analyticsPages]
}
