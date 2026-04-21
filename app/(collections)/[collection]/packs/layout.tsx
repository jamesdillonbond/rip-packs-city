import type { Metadata } from "next"
import type { ReactNode } from "react"
import Link from "next/link"
import { collectionHasPage, getCollection } from "@/lib/collections"
import { pageMetadata } from "@/lib/seo"

export async function generateMetadata(
  props: { params: Promise<{ collection: string }> }
): Promise<Metadata> {
  const { collection: id } = await props.params
  const collection = getCollection(id)
  if (!collection) return pageMetadata("packs", "Flow", id)
  return pageMetadata("packs", collection.label, collection.id)
}

// Packs currently exist only for Top Shot + NFL All Day. For other
// collections, render a graceful "coming soon" shell rather than letting
// the packs page fetch endpoints that will 404 and flash broken UI.
export default async function PacksLayout(props: { children: ReactNode; params: Promise<{ collection: string }> }) {
  const { collection: id } = await props.params
  if (collectionHasPage(id, "packs")) {
    return <>{props.children}</>
  }

  const collection = getCollection(id)
  const label = collection?.label ?? "this collection"
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "80px 24px", gap: 14 }}>
      <div style={{ fontSize: 48 }}>{collection?.icon ?? "\u{1F4E6}"}</div>
      <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 900, fontSize: 24, letterSpacing: "0.06em", color: "#fff", textTransform: "uppercase" }}>
        Pack tools coming soon for {label}
      </div>
      <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 12, color: "rgba(255,255,255,0.5)", lineHeight: 1.7, maxWidth: 460 }}>
        Pack EV is a core tool for primary-market collections. {label} either doesn&apos;t sell packs today or the pipeline isn&apos;t seeded yet. Use the Sniper and Overview tabs for live deals and market state.
      </div>
      <Link
        href={`/${id}/overview`}
        style={{ display: "inline-block", padding: "10px 24px", background: "var(--rpc-accent, #E03A2F)", borderRadius: 6, color: "#fff", fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 13, letterSpacing: "0.06em", textTransform: "uppercase", textDecoration: "none", marginTop: 8 }}
      >
        Back to Overview
      </Link>
    </div>
  )
}
