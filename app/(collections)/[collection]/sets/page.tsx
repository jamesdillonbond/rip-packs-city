// app/(collections)/[collection]/sets/page.tsx
//
// Server shell. The set tracker lives in CollectionSetsClient so the COMPONENT coverage gate
// measures it — `app/**/page.tsx` matches neither gate's include.
//
// Reading `params` here removes the client's `useParams()`, so the slug arrives as a plain
// prop and the client is renderable by a test without a router.

import CollectionSetsClient from "./CollectionSetsClient";
import PaniniSetProgress from "@/components/collection/PaniniSetProgress";

export default async function SetsPage({
  params,
}: {
  params: Promise<{ collection: string }>;
}) {
  const { collection } = await params;
  // Panini (no chain, owners are usernames): its own tracker over
  // panini_set_progress — the shared client keys on a wallet address and on
  // `editions` set membership, neither of which Panini has (2026-09-27).
  if (collection === "panini-blockchain") return <PaniniSetProgress />;
  return <CollectionSetsClient collection={collection} />;
}
