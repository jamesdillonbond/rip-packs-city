// app/(collections)/[collection]/overview/page.tsx
//
// Server shell. The overview lives in CollectionOverviewClient so the COMPONENT coverage
// gate measures it — `app/**/page.tsx` matches neither gate's include, and this page carries
// the three-way "read failed / no rows / no NAMEABLE rows" distinction that deep-audit D11,
// R1 and R4 each fixed one layer of. All of it was pinned only by source greps until now.
//
// Reading `params` here also removes the client's `useParams()`, so the slug arrives as a
// plain prop and the client is renderable by a test without a router.

import CollectionOverviewClient from "./CollectionOverviewClient";
import { Suspense } from "react";
import { CollectionMarketCapTile } from "@/components/entity/MarketCapTile";
import { getCollectionByUrlSlug } from "@/lib/collection-slug";
import { supabaseAdmin } from "@/lib/supabase";
import { normalizeStatsSlug, readCollectionStats } from "@/lib/collection-stats/read";

export default async function OverviewPage({
  params,
}: {
  params: Promise<{ collection: string }>;
}) {
  const { collection } = await params;
  // Market cap is a server read (bounded, Suspense-wrapped) handed to the client as
  // a slot, so a slow read never holds the overview. An unknown slug gets no tile.
  const dbSlug = getCollectionByUrlSlug(collection)?.dbSlug ?? null;
  const marketCapSlot = dbSlug ? (
    <Suspense fallback={null}>
      <CollectionMarketCapTile collectionDbSlug={dbSlug} />
    </Suspense>
  ) : null;
  // Review E2 (2026-10-13): the KPI band's first paint comes from the server —
  // the same read the client's live refresh makes (lib/collection-stats/read.ts)
  // — so a crawler and a first frame carry the numbers instead of em-dashes.
  // The segment is ISR (overview/layout.tsx, 1 h), so the client STILL
  // refreshes on mount; the seed is only ever the first frame. A failed read
  // seeds null: the client then renders exactly what it renders today (its own
  // read, its own three-way honesty), and ISR never caches a claim out of a
  // failure (#33) because null IS the absence.
  let initialStats: Record<string, unknown> | null = null;
  const seed = await readCollectionStats(supabaseAdmin, normalizeStatsSlug(collection), "overview/page");
  if (seed.ok) initialStats = seed.stats;
  else if (seed.kind === "unavailable") console.log("[overview/page] stats seed unavailable; client will read live");
  return (
    <CollectionOverviewClient
      collection={collection}
      marketCapSlot={marketCapSlot}
      initialStats={initialStats as never}
    />
  );
}
