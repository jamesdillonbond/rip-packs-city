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

export default async function OverviewPage({
  params,
}: {
  params: Promise<{ collection: string }>;
}) {
  const { collection } = await params;
  return <CollectionOverviewClient collection={collection} />;
}
