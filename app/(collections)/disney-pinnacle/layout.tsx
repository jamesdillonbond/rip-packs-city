import type { Metadata } from "next"
import { getCollection } from "@/lib/collections"
import { collectionPageJsonLd, BRAND_TITLE_TEMPLATE } from "@/lib/seo"
import { CollectionTicker, CollectionBanner } from "@/components/collection-chrome"
import ActiveCollectionSync from "../[collection]/ActiveCollectionSync"
import WalletHydrator from "@/components/WalletHydrator"
import WalletSearchBand from "@/components/WalletSearchBand"

export const metadata: Metadata = {
  // Same two defects as collectionLayoutMetadata, in a static segment that does
  // not use it: the baked brand was being fed to the root template, so
  // /disney-pinnacle/collection rendered
  // "Disney Pinnacle Analytics — Rip Packs City | Rip Packs City" live.
  title: { absolute: "Disney Pinnacle Analytics — Rip Packs City", template: BRAND_TITLE_TEMPLATE },
  description:
    "Marketplace sniper and analytics for Disney Pinnacle pin collectors on the Flow blockchain.",
}

// The Pinnacle collection + sniper tabs are served from their own bespoke page
// dirs under this static segment, so they use THIS layout rather than the generic
// /[collection]/layout.tsx that the other 4 Pinnacle tabs fall through to. Both
// layouts now render the exact same shared chrome (CollectionTicker +
// CollectionBanner from components/collection-chrome) so the header/ticker is
// byte-identical across all 6 tabs — fixing the theme/structure re-skin (H3).
export default function DisneyPinnacleLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const collection = getCollection("disney-pinnacle")!
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
        {/* Parity with the generic /[collection]/layout.tsx — this bespoke
            layout serves the Pinnacle collection + sniper tabs from their own
            page dirs, so the wedge has to be mounted here too or those tabs
            silently lose it. */}
        <WalletSearchBand scope="collection" collectionId={collection.id} />
        {children}
      </main>
    </div>
  )
}
