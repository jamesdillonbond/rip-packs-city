import type { Metadata } from "next"
import Link from "next/link"
import { getCollection, publishedCollections } from "@/lib/collections"
import { collectionLayoutMetadata, collectionPageJsonLd } from "@/lib/seo"
import ActiveCollectionSync from "./ActiveCollectionSync"
import WalletHydrator from "@/components/WalletHydrator"
import { CollectionTicker, CollectionBanner } from "@/components/collection-chrome"

export async function generateMetadata(
  props: { params: Promise<{ collection: string }> }
): Promise<Metadata> {
  const params = await props.params
  return collectionLayoutMetadata(params.collection)
}

// ── Layout — renders ticker, breadcrumb, collection header, tabs ──────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function CollectionSegmentLayout(props: any) {
  const params = await props.params
  const collectionId: string = params?.collection ?? ""
  const collection = getCollection(collectionId)

  // Unknown collection → fall back to first published collection
  if (!collection) {
    const fallback = publishedCollections()[0]
    return (
      <div data-collection={fallback.id}>
        <ActiveCollectionSync collectionId={fallback.id} />
        <CollectionTicker collection={fallback} />
        <CollectionBanner collection={fallback} />
        <main className="rpc-main" style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 24px 60px" }}>
          {props.children}
        </main>
      </div>
    )
  }

  // Unpublished collection → show "Coming Soon" in the layout shell
  if (!collection.published) {
    return (
      <div data-collection={collection.id}>
        <ActiveCollectionSync collectionId={collection.id} />
        <CollectionTicker collection={collection} />
        <CollectionBanner collection={collection} />
        <main className="rpc-main" style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 24px 60px" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "80px 24px" }}>
            <div style={{ fontSize: 56, marginBottom: 20 }}>{collection.icon}</div>
            <div style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 28, letterSpacing: "0.06em", color: "var(--rpc-text-primary)", textTransform: "uppercase", marginBottom: 12 }}>
              {collection.label}
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--rpc-text-secondary)", lineHeight: 1.7, maxWidth: 480, marginBottom: 32 }}>
              {"We\u2019re building something great for " + collection.label + " \u2014 check back soon."}
            </div>
            {/* brand-exception: white label on the red button \u2014 theme-independent */}
            <Link href="/nba-top-shot/overview" style={{ display: "inline-block", padding: "10px 24px", background: "var(--rpc-red)", borderRadius: 6, color: "#fff", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 13, letterSpacing: "0.06em", textTransform: "uppercase", textDecoration: "none" }}>
              Back to NBA Top Shot
            </Link>
          </div>
        </main>
      </div>
    )
  }

  // CollectionPage + BreadcrumbList JSON-LD for every page under
  // /[collection]/*. Inlined as a <script> so search engines consume it on
  // SSR — Google's Rich Results Test will validate against this exact block.
  const jsonLd = collectionPageJsonLd(collection.id)

  return (
    <div data-collection={collection.id}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <ActiveCollectionSync collectionId={collection.id} />
      <WalletHydrator />
      <CollectionTicker collection={collection} />
      <CollectionBanner collection={collection} />
      <main className="rpc-main" style={{ maxWidth: 1440, margin: "0 auto", padding: "24px 24px 60px" }}>
        {props.children}
      </main>
    </div>
  )
}
