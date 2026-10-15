// lib/blog/posts.ts
//
// THE single source for the blog's post list. app/blog/page.tsx (the index),
// each app/blog/<slug>/page.tsx (BlogPosting JSON-LD + og:article dates) and
// app/feed.xml/route.ts (RSS 2.0) all read this array — before 2026-10-11 the
// index held its own copy with display-formatted dates and nothing else knew
// when a post was published (review §3 E3).
//
// Dates are ISO (YYYY-MM-DD) so schema.org, <pubDate> and the display string
// are all DERIVED from one value rather than three spellings of it.

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export type BlogPost = {
  slug: string
  title: string
  /** Published, ISO date. */
  date: string
  /** Last substantive edit, ISO date. Absent = never edited after publish. */
  dateModified?: string
  collection: string
  blurb: string
  readMin: number
  /** Absolute share image: the post's own card (app/api/og/blog/[slug]), 2026-10-14. */
  image: string
}

export const BLOG_POSTS: readonly BlogPost[] = [
  {
    slug: "premium-chance-hit-vs-chance-hit",
    title: "Premium Chance Hit vs Chance Hit: What NBA Top Shot's Pack Contents Say",
    date: "2026-10-14",
    collection: "NBA Top Shot",
    blurb:
      "Rare-or-better Moments per pack across 10 paired Top Shot drops, from the contents Top Shot published. Premium was cheaper per hit in 8 of 10 releases; both Rookie Revelation drops went the other way.",
    readMin: 4,
    image: `${BASE_URL}/api/og/blog/premium-chance-hit-vs-chance-hit`,
  },
  {
    slug: "permanent-moments-ipfs",
    title: "Your Moments Just Became Permanent. Here's What That Actually Means.",
    date: "2026-06-09",
    // The post carries an "Update — June 10, 2026" paragraph.
    dateModified: "2026-06-10",
    collection: "NBA Top Shot",
    blurb:
      "Top Shot just pinned every Moment's video to IPFS. What content-addressing actually guarantees, how to verify a Moment yourself in 30 seconds, and what we built with the data.",
    readMin: 6,
    image: `${BASE_URL}/api/og/blog/permanent-moments-ipfs`,
  },
  {
    slug: "pinnacle-star-wars-day-2026",
    title: "Star Wars Day 2026 on Disney Pinnacle: What's Actually Moving",
    date: "2026-05-07",
    collection: "Disney Pinnacle",
    blurb:
      "53 editions, 14 sets, 408 historical sales. Where the Mandalorian peak buyers are now underwater, the only edition trading below FMV with HIGH confidence, and what we still don't know.",
    readMin: 8,
    image: `${BASE_URL}/api/og/blog/pinnacle-star-wars-day-2026`,
  },
]

/**
 * The Premium Chance Hit explainer, for a Top Shot pack whose title names
 * either pack type — the pages "premiumchance" searchers land on (GSC 09-06).
 * Null for anything else, so no other pack page grows an irrelevant link.
 */
export function chanceHitExplainerHref(collectionUrlSlug: string, packTitle: string): string | null {
  if (collectionUrlSlug !== "nba-top-shot") return null
  return /chance\s*hit/i.test(packTitle) ? "/blog/premium-chance-hit-vs-chance-hit" : null
}

export function getBlogPost(slug: string): BlogPost | undefined {
  return BLOG_POSTS.find((p) => p.slug === slug)
}

export function blogPostUrl(post: BlogPost): string {
  return `${BASE_URL}/blog/${post.slug}`
}

/** "June 9, 2026" — the display form the index and post kickers already used. */
export function formatPostDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  })
}
