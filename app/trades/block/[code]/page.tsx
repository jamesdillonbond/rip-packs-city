// app/trades/block/[code]/page.tsx
//
// One Trade Block listing (public). Server shell only — no database read here: the surface
// (ListingClient) reads /api/public/trade-block/<code>, whose failure states it renders.
//
// Listing pages are NOINDEX by design: a listing lives 30 days and closes whenever its
// owner trades, so an indexed listing is mostly a stale or dead URL for a searcher, and an
// unresolvable code must never be an indexable duplicate (the seo-unresolvable-slug
// lesson). The browse page (/trades/block) is the indexed surface.

import type { Metadata } from "next";
import ListingClient from "./ListingClient";

type Props = { params: Promise<{ code: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code } = await params;
  return {
    title: "Trade listing",
    description: "A collector's trade listing on the Rip Packs City Trade Block: what they'd trade and what they want back. Asset for asset, no cash.",
    alternates: { canonical: `/trades/block/${code}` },
    robots: { index: false, follow: true },
  };
}

export default async function ListingPage({ params }: Props) {
  const { code } = await params;
  return <ListingClient code={code} />;
}
