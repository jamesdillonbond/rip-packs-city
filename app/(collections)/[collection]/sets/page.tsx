// app/(collections)/[collection]/sets/page.tsx
//
// Server shell. The set tracker lives in CollectionSetsClient so the COMPONENT coverage gate
// measures it — `app/**/page.tsx` matches neither gate's include.
//
// Reading `params` here removes the client's `useParams()`, so the slug arrives as a plain
// prop and the client is renderable by a test without a router.

import CollectionSetsClient from "./CollectionSetsClient";

export default async function SetsPage({
  params,
}: {
  params: Promise<{ collection: string }>;
}) {
  const { collection } = await params;
  return <CollectionSetsClient collection={collection} />;
}
