// app/(collections)/[collection]/property/[slug]/page.tsx
//
// One league / brand a publisher covers (2026-11-26): Panini's FIFA World Cup, NBA, WNBA, Bad Eggs … and
// Candy's MLB, DC, NASCAR, WWE … — the registry's `propertyPages` names which reader serves the collection.
// The layout gates existence; this page renders PaniniPropertyBody or, on a failed read, says it couldn't
// load. Data: lib/panini/properties.ts (get_panini_property_page, migration 20261126193845).
// ⛔ "property" is a URL / code word only — the page says "League" or "Entertainment".

import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { getCollection } from "@/lib/collections"
import { decodeSlugOrNull } from "@/lib/entity-detail-gate"
import { collectionDisplayName, collectionEntityJsonLd, collectionOgUrl, entityUrl, NOT_FOUND_METADATA, OG_INHERITED, TWITTER_INHERITED } from "@/lib/seo"
import { jsonLdScript } from "@/lib/seo/json-ld-script"
import { fetchPaniniPropertyGroups, fetchPaniniPropertyPage } from "@/lib/panini/properties"
import PaniniPropertyBody, { PaniniPropertyUnavailable } from "@/components/entity/PaniniPropertyBody"
import { fetchCandyPropertyPage } from "@/lib/candy/properties"
import CandyPropertyBody, { CandyPropertyUnavailable } from "@/components/entity/CandyPropertyBody"

export const revalidate = 1800

type Props = { params: Promise<{ collection: string; slug: string }> }

async function load(props: Props) {
  const { collection, slug: raw } = await props.params
  const coll = getCollectionByUrlSlug(collection)
  return { collection, coll, slug: decodeSlugOrNull(raw), reader: coll ? getCollection(coll.urlSlug)?.propertyPages : undefined }
}

const shell = { maxWidth: 1100, margin: "0 auto", padding: "16px 16px 48px" } as const

async function candyMetadata(collection: string, slug: string): Promise<Metadata> {
  const res = await fetchCandyPropertyPage(slug)
  if (!res.ok) return { title: "Candy cards", robots: { index: false, follow: true } }
  const p = res.page
  if (!p) return NOT_FOUND_METADATA
  const url = entityUrl(collection, "property", p.slug)
  const title = `Candy ${p.name} Cards — Collections, Values & Sales`
  const n = p.collections.length
  const description = `Candy's digital ${p.name} cards: ${n.toLocaleString("en-US")} ${n === 1 ? "collection" : "collections"} and ${p.cards.toLocaleString("en-US")} cards in circulation, with fair market values, live asks and recent sales.`
  const image = collectionOgUrl(collection)
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { ...OG_INHERITED, title, description, url, images: [{ url: image, width: 1200, height: 630, alt: `Candy ${p.name} cards` }] },
    twitter: { ...TWITTER_INHERITED, title, description, images: [image] },
  }
}

async function CandyPage({ collection, slug }: { collection: string; slug: string }) {
  const res = await fetchCandyPropertyPage(slug)
  if (!res.ok) return <CandyPropertyUnavailable collection={collection} />
  if (!res.page) notFound()
  const jsonLd = collectionEntityJsonLd({
    name: `Candy ${res.page.name} cards`,
    url: entityUrl(collection, "property", res.page.slug),
    collectionUrlSlug: collection,
    eds: res.page.top_editions.map((e) => ({ route_slug: e.external_id, player_name: e.player_name ?? e.name, thumbnail_url: null })),
    crumbName: res.page.name,
  })
  return (
    <div style={shell}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      <CandyPropertyBody collection={collection} collectionLabel={collectionDisplayName(collection)} page={res.page} />
    </div>
  )
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { collection, coll, slug, reader } = await load(props)
  if (!coll || !reader || slug === null) return NOT_FOUND_METADATA
  if (reader === "candy") return candyMetadata(collection, slug)
  const res = await fetchPaniniPropertyPage(slug)
  if (!res.ok) return { title: "Panini cards", robots: { index: false, follow: true } }
  const p = res.page
  if (!p) return NOT_FOUND_METADATA
  const url = entityUrl(collection, "property", p.slug)
  const title = `Panini ${p.name} Cards — Values, Products & Sales`
  const description = `Panini's digital ${p.name} cards: ${p.products.length.toLocaleString("en-US")} ${p.products.length === 1 ? "product" : "products"} and ${p.editions.toLocaleString("en-US")} cards RPC has seen, with fair market values, live asks on Panini's marketplace and recent sales.`
  const image = collectionOgUrl("panini-blockchain")
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { ...OG_INHERITED, title, description, url, images: [{ url: image, width: 1200, height: 630, alt: `Panini ${p.name} cards` }] },
    twitter: { ...TWITTER_INHERITED, title, description, images: [image] },
  }
}

export default async function PaniniPropertyPage(props: Props) {
  const { collection, coll, slug, reader } = await load(props)
  if (!coll || !reader || slug === null) notFound()
  if (reader === "candy") return <CandyPage collection={collection} slug={slug} />
  // The groups read is an optional section: it runs alongside and its failure leaves the section out.
  const [res, groups] = await Promise.all([fetchPaniniPropertyPage(slug), fetchPaniniPropertyGroups(slug)])
  if (!res.ok) return <PaniniPropertyUnavailable collection={collection} />
  if (!res.page) notFound()
  const jsonLd = collectionEntityJsonLd({
    name: `Panini ${res.page.name} cards`,
    url: entityUrl(collection, "property", res.page.slug),
    collectionUrlSlug: collection,
    eds: res.page.top_editions.map((e) => ({ route_slug: e.external_id, player_name: e.player_name, thumbnail_url: e.thumbnail_url })),
    crumbName: res.page.name,
  })
  return (
    <div style={shell}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      <PaniniPropertyBody collection={collection} collectionLabel={collectionDisplayName(collection)} page={res.page} groups={groups} />
    </div>
  )
}
